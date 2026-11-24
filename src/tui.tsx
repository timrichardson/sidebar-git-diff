/** @jsxImportSource @opentui/solid */
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { posix, win32 } from "node:path"
import type { LocationGetOutput, SessionInfo, SessionMessageAssistantTool, VcsFileStatus } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import { MouseButton, TextAttributes } from "@opentui/core"
import { createMemo, createResource, createSignal, For, Match, onCleanup, onMount, Show, Switch } from "solid-js"
import { unwrap } from "solid-js/store"

const SESSION_LIMIT = 30
const PAGE_SIZE = 50
const PAGES_PER_REFRESH = 4
const CONCURRENCY = 4
const WORKTREE_LIMIT = 30
const REFRESH_MS = 10_000

type History = { edits: ReadonlyMap<string, number>; partial: boolean }
type SessionChanges = { session: SessionInfo; root: string; history: History }
type Scope = Pick<SessionInfo, "location" | "subpath">
type Checkpoint = {
  revision: string
  scope: string
  directory: string
  position?: { cursor: string; messageID: string }
  edits: [string, number][]
  synced?: { updated: number; idle?: number }
}
type EditIndex = Record<string, Checkpoint | undefined>
type IndexUpdate = { sessionID: string; expectedRevision?: string; checkpoint?: Checkpoint }
type WorktreeChanges = { root: string; label: string; files: VcsFileStatus[]; error?: boolean }
type SidebarScan = {
  worktrees: WorktreeChanges[]
  roots: string[]
  sessions: Map<string, SessionChanges>
  partial: boolean
}
type FileLink = { root: string; file: string; sessionID: string }

function serverPath(directory: string) {
  return directory.startsWith("/") ? posix : win32
}

function relativeFile(root: string, absolute: string) {
  const path = serverPath(root)
  const relative = path.relative(root, absolute)
  const file = relative.split(path.sep).join("/")
  return file === ".." || file.startsWith("../") || path.isAbsolute(relative) ? undefined : file
}

function sessionRoot(scope: Scope, roots: readonly string[]) {
  return roots.find((root) => relativeFile(root, scope.location.directory) === (scope.subpath ?? ""))
}

/** Read paths from successful native mutations, not snapshots of a shared worktree. */
function writtenPaths(tool: SessionMessageAssistantTool): string[] {
  if (tool.state.status !== "completed") return []
  if (tool.name === "write") {
    const file = tool.state.input.path
    // The server expands a leading tilde using a home directory the client may not share.
    return typeof file === "string" && file && !/^~([/\\]|$)/.test(file) ? [file] : []
  }
  if (tool.name !== "edit" && tool.name !== "patch") return []
  const files = tool.state.metadata?.files
  if (!Array.isArray(files)) return []
  return files.flatMap((entry) =>
    entry && typeof entry === "object" && "file" in entry && typeof entry.file === "string" ? [entry.file] : [],
  )
}

/** Record server-absolute edit paths, including edits outside the session's assigned worktree. */
async function readHistory(
  client: Plugin.Context["client"],
  session: SessionInfo,
  previous: Checkpoint | undefined,
  signal: AbortSignal,
): Promise<History & { checkpoint?: Checkpoint }> {
  const scope = JSON.stringify([session.projectID, session.time.created])
  let checkpoint = previous?.scope === scope ? previous : undefined
  let position = checkpoint?.position
  let directory = checkpoint?.directory
  const edits = new Map(checkpoint?.edits)
  const { updated, idle, busy } = session.time
  if (checkpoint?.synced?.updated === updated && checkpoint.synced.idle === idle && (busy ?? 0) <= (idle ?? 0)) {
    return { edits, checkpoint, partial: false }
  }

  try {
    for (let page = 0; page < PAGES_PER_REFRESH; page++) {
      if (directory === undefined) {
        const { data: [firstMove] } = await client.message.list(
          { sessionID: session.id, order: "asc", type: "location-switched", limit: 1 },
          { signal },
        )
        directory =
          (firstMove?.type === "location-switched" ? firstMove.previous?.location.directory : undefined) ??
          session.location.directory
      }

      const result = await client.message.list(
        { sessionID: session.id, limit: PAGE_SIZE, ...(position ? { cursor: position.cursor } : { order: "asc" }) },
        { signal },
      )
      // A committed revert can remove the cursor's message. An empty page alone is not proof.
      if (page === 0 && position && result.data.length === 0) {
        try {
          await client.session.message.get({ sessionID: session.id, messageID: position.messageID }, { signal })
        } catch (error) {
          if (!(typeof error === "object" && error && "_tag" in error && error._tag === "MessageNotFoundError")) throw error
          checkpoint = undefined
          position = undefined
          directory = undefined
          edits.clear()
          continue
        }
      }

      let unsettled = false
      for (const message of result.data) {
        if (message.type === "location-switched") {
          directory = message.location.directory
          continue
        }
        if (message.type !== "assistant" || !directory) continue
        // A fork inherits its source history. Do not count copied edits.
        if (session.fork && message.time.created < session.time.created) continue
        if (
          message.time.completed === undefined &&
          message.time.created > (idle ?? -Infinity) &&
          message.time.created >= (busy ?? updated)
        ) {
          unsettled = true
        }

        for (const part of message.content) {
          if (part.type !== "tool") continue
          const time = part.time.completed ?? message.time.completed
          if (time === undefined) continue
          for (const resource of writtenPaths(part)) {
            const file = serverPath(directory).resolve(directory, resource)
            if (time > (edits.get(file) ?? -Infinity)) edits.set(file, time)
          }
        }
      }
      const caughtUp = !result.cursor.next || result.data.length < PAGE_SIZE
      // Show completed tools in the active page, but read it again before saving its cursor.
      if (unsettled) return { edits, checkpoint, partial: !caughtUp }

      const last = result.data.at(-1)
      if (last && result.cursor.next) position = { cursor: result.cursor.next, messageID: last.id }
      const synced = caughtUp ? { updated, idle } : undefined
      if (
        position !== checkpoint?.position ||
        directory !== checkpoint?.directory ||
        synced?.updated !== checkpoint?.synced?.updated ||
        synced?.idle !== checkpoint?.synced?.idle
      ) {
        checkpoint = { revision: randomUUID(), scope, directory, position, edits: [...edits], synced }
      }
      if (caughtUp) return { edits, checkpoint, partial: false }
    }
  } catch {
    return { edits: new Map(checkpoint?.edits), checkpoint, partial: true }
  }
  return { edits, checkpoint, partial: true }
}

function displayPath(file: string) {
  return file.replaceAll(/[\x00-\x1f\x7f-\x9f]/g, "�")
}

/** Count commits against the local copy of the remote tracking branch, without contacting the remote. */
function readAhead(root: string, branch: string, signal: AbortSignal) {
  const ref = `refs/heads/${branch}`
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: "C", GIT_NO_LAZY_FETCH: "1", GIT_TERMINAL_PROMPT: "0" }
  delete env.GIT_COMMON_DIR
  delete env.GIT_NAMESPACE
  return new Promise<string>((resolve) => {
    execFile(
      "git",
      [
        "--git-dir=.git",
        "--work-tree=.",
        "for-each-ref",
        "--count=1",
        "--format=%(refname)%00%(HEAD)%00%(upstream:remotename)%00%(upstream:track,nobracket)",
        "--",
        ref,
      ],
      { cwd: root, env, signal, maxBuffer: 16_384, windowsHide: true },
      (error, output) => {
        if (error) return resolve("?")
        const [name, head, remote, tracking] = output.trimEnd().split("\0")
        if (name !== ref || head !== "*") return resolve("?")
        if (!remote || remote === "." || tracking === "gone") return resolve("-")
        const ahead = tracking?.match(/^ahead (\d+)(?:,|$)/)?.[1]
        if (ahead !== undefined) return resolve(`+${ahead}`)
        resolve(tracking === "" || (tracking && /^behind \d+$/.test(tracking)) ? "+0" : "?")
      },
    )
  })
}

/** Isolate read failures and limit concurrent server requests. */
async function readBatch<T, R>(items: readonly T[], read: (item: T) => Promise<R>) {
  const results: PromiseSettledResult<R>[] = []
  for (let offset = 0; offset < items.length; offset += CONCURRENCY) {
    results.push(...(await Promise.allSettled(items.slice(offset, offset + CONCURRENCY).map(read))))
  }
  return results
}

async function readWorktree(client: Plugin.Context["client"], root: string, local: boolean, lifetime: AbortSignal) {
  const label = `📁 ${displayPath(root)}`
  try {
    const location = { directory: root }
    const signal = AbortSignal.any([lifetime, AbortSignal.timeout(10_000)])
    const { data: files } = await client.vcs.status({ location }, { signal })
    if (!files.length) return { root, label, files }

    const branchSignal = AbortSignal.any([lifetime, AbortSignal.timeout(3_000)])
    const vcs = await client.vcs
      .get({ location }, { signal: branchSignal })
      .then(({ data }) => data, () => undefined)
    const branch = vcs?.branch.current
    const branchLabel = branch ?? (vcs?.provider === "git" ? "detached HEAD" : "branch unavailable")
    const ahead =
      vcs?.provider === "git" && !branch ? "-" : branch && local ? await readAhead(root, branch, branchSignal) : "?"
    return { root, label: `${label} · ⑂ ${displayPath(branchLabel)} (${ahead})`, files }
  } catch {
    return { root, label, files: [], error: true }
  }
}

function Sidebar(props: {
  context: Plugin.Context
  sessionID: string
  directory: string
  editIndex: EditIndex
  saveIndex: (updates: IndexUpdate[]) => Promise<void>
  collapsedSessions: () => ReadonlySet<string>
  setSessionsCollapsed: (sessionIDs: readonly string[], collapsed: boolean) => void
}) {
  const { client, data, theme, ui } = props.context
  const [scan, setScan] = createSignal<SidebarScan>()
  const [projectError, setProjectError] = createSignal(false)
  let scope: LocationGetOutput | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  const lifetime = new AbortController()
  // In the OpenCode 2.3.2 CLI, an explicit --server can point to a different filesystem.
  const local = !process.argv.some((arg) => arg === "--server" || arg.startsWith("--server="))
  const tabs = createMemo(() => {
    if (!ui.tabs.enabled()) return [{ sessionID: props.sessionID, title: undefined }]
    const open = ui.tabs.list()
    const rootID = data.session.root(props.sessionID)
    return open.some((tab) => tab.sessionID === rootID) ? open : [...open, { sessionID: rootID, title: undefined }]
  })

  async function refresh() {
    try {
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)])
      scope ??= await client.location.get({ location: { directory: props.directory } }, { signal })
      const project = scope.project
      const activeRoot = project.directory
      const open = tabs()
      const candidates = open.slice(0, SESSION_LIMIT)
      const activeID = data.session.root(props.sessionID)
      const active = open.find((tab) => tab.sessionID === activeID)
      if (active && !candidates.includes(active)) candidates[SESSION_LIMIT - 1] = active

      // Use saved worktree paths to locate edits. Do not read Git status for unrelated checkouts.
      const inventory = await client.worktree.list({ projectID: project.id }, { signal }).catch(() => undefined)
      const knownRoots = [...new Set([activeRoot, ...(inventory?.map((tree) => tree.directory) ?? [])])]
      const sessions = new Map<string, SessionChanges>()
      const updates: IndexUpdate[] = []
      let partial = !inventory || open.length > candidates.length
      const results = await readBatch(candidates, async ({ sessionID }): Promise<SessionChanges | undefined> => {
        const session = await client.session.get({ sessionID }, { signal })
        if (session.projectID !== project.id) return
        let root = sessionRoot(session, knownRoots)
        if (!root) {
          const found = await client.location.get({ location: session.location }, { signal })
          if (found.project.id !== project.id) return
          root = found.project.directory
        }
        // Storage can update while an API read is in flight.
        const stored = props.editIndex[session.id]
        const before = stored && structuredClone(unwrap(stored))
        const history = await readHistory(client, session, before, signal)
        if (before?.revision !== history.checkpoint?.revision) {
          updates.push({ sessionID: session.id, expectedRevision: before?.revision, checkpoint: history.checkpoint })
        }
        return { session, root, history }
      })
      for (const result of results) {
        if (result.status === "rejected") {
          partial = true
          continue
        }
        const entry = result.value
        if (!entry) continue
        partial ||= entry.history.partial
        sessions.set(entry.session.id, entry)
      }

      const selected = new Set([activeRoot])
      for (const { root } of sessions.values()) selected.add(root)
      const roots = [...new Set([...selected, ...knownRoots])].sort((a, b) => b.length - a.length)
      for (const { history } of sessions.values()) {
        for (const file of history.edits.keys()) {
          const root = roots.find((root) => relativeFile(root, file))
          if (root) selected.add(root)
        }
      }
      partial ||= selected.size > WORKTREE_LIMIT
      const statusSignal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)])
      const statuses = await readBatch([...selected].slice(0, WORKTREE_LIMIT), (root) =>
        readWorktree(client, root, local, statusSignal),
      )
      const worktrees = statuses.flatMap((result) => (result.status === "fulfilled" ? [result.value] : []))
      partial ||= statuses.length !== worktrees.length
      if (lifetime.signal.aborted) return
      setProjectError(false)
      setScan({ worktrees, roots, sessions, partial })
      if (updates.length) {
        await props.saveIndex(updates).catch(() => {
          if (!lifetime.signal.aborted) setScan({ worktrees, roots, sessions, partial: true })
        })
      }
    } catch {
      if (!lifetime.signal.aborted) setProjectError(true)
    }
  }

  async function poll() {
    await refresh()
    if (!lifetime.signal.aborted) timer = setTimeout(() => void poll(), REFRESH_MS)
  }
  onMount(() => void poll())
  onCleanup(() => {
    lifetime.abort()
    clearTimeout(timer)
  })

  const worktrees = createMemo(() => {
    const result = scan()
    if (!result) return []
    const open = tabs()
    // Keep paths from distinct worktrees separate, even if the file names match.
    const owners = new Map<string, Map<string, { sessionID?: string; time: number }>>()
    for (const tab of open) {
      const entry = result.sessions.get(tab.sessionID)
      if (!entry) continue
      for (const [absolute, time] of entry.history.edits) {
        const root = result.roots.find((root) => relativeFile(root, absolute))
        const file = root && relativeFile(root, absolute)
        if (!root || !file) continue
        const files = owners.get(root) ?? new Map()
        const previous = files.get(file)
        if (!previous || time > previous.time) files.set(file, { sessionID: tab.sessionID, time })
        else if (time === previous.time && previous.sessionID !== tab.sessionID) files.set(file, { time })
        owners.set(root, files)
      }
    }

    return result.worktrees.filter((tree) => tree.error || tree.files.length).map((tree) => {
      const byTab = new Map<string | undefined, VcsFileStatus[]>()
      for (const file of tree.files) {
        const owner = owners.get(tree.root)?.get(file.file)?.sessionID
        const changes = byTab.get(owner) ?? []
        changes.push(file)
        byTab.set(owner, changes)
      }
      const groups: { id?: string; label: string; files: VcsFileStatus[] }[] = open.flatMap((tab) => {
        const files = byTab.get(tab.sessionID)
        if (!files) return []
        const label = data.session.get(tab.sessionID)?.title ?? tab.title ?? result.sessions.get(tab.sessionID)?.session.title
        return [{ id: JSON.stringify([tree.root, tab.sessionID]), label: label || tab.sessionID, files }]
      })
      const unassigned = byTab.get(undefined)
      if (unassigned) groups.push({ label: "Unassigned", files: unassigned })
      return { ...tree, groups }
    })
  })
  const count = createMemo(() => worktrees().reduce((total, tree) => total + tree.files.length, 0))
  const sessionGroupIDs = createMemo(() =>
    worktrees().flatMap((tree) => tree.groups.flatMap(({ id }) => (id ? [id] : []))),
  )
  const canToggleAll = () => !projectError() && sessionGroupIDs().length > 0
  const allCollapsed = () => sessionGroupIDs().every((sessionID) => props.collapsedSessions().has(sessionID))
  const allAction = () => (allCollapsed() ? "Expand all" : "Collapse all")
  const toggleAll = () => {
    if (canToggleAll()) props.setSessionsCollapsed(sessionGroupIDs(), !allCollapsed())
  }
  props.context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: "sidebar-git-diff.toggle-all",
        title: `${allAction()} Git change groups`,
        group: "VCS",
        palette: true,
        enabled: canToggleAll,
        run: toggleAll,
      },
    ],
  }))
  const marker = { added: "A", deleted: "D", modified: "M" } as const

  return (
    <Show when={projectError() || worktrees().length > 0 || scan()?.partial}>
      <box>
        <box flexDirection="row" justifyContent="space-between" gap={1}>
          <text fg={theme.text.base} wrapMode="word" flexShrink={1} minWidth={0}>
            <b>Git changes ({count()})</b>
          </text>
          <Show when={canToggleAll()}>
            <text
              fg={theme.markdown.linkText}
              attributes={TextAttributes.UNDERLINE}
              flexShrink={0}
              selectable={false}
              onMouseUp={(event) => {
                if (event.button !== MouseButton.LEFT || event.isDragging) return
                event.stopPropagation()
                toggleAll()
              }}
            >
              {allAction()}
            </text>
          </Show>
        </box>
        <Show when={projectError()}>
          <text fg={theme.text.feedback.error.base} wrapMode="word">
            Could not read the project or its worktrees.
          </text>
        </Show>
        <Show when={!projectError()}>
          <text fg={theme.text.muted} wrapMode="word">
            {scan()?.partial ? "Partial session or worktree results" : "Latest recorded file edits"}
          </text>
          <For each={worktrees()}>
            {(tree) => (
              <box marginTop={1}>
                <text fg={theme.text.muted} wrapMode="char">
                  <b>{tree.label}</b>
                </text>
                <Show when={tree.error}>
                  <text fg={theme.text.feedback.error.base}>Could not read Git status.</text>
                </Show>
                <For each={tree.groups}>
                  {(group) => {
                    const id = group.id
                    const expanded = () => !id || !props.collapsedSessions().has(id)
                    return (
                      <box>
                        <text
                          fg={theme.text.base}
                          wrapMode="char"
                          selectable={!id}
                          onMouseUp={
                            id
                              ? (event) => {
                                  if (event.button !== MouseButton.LEFT || event.isDragging) return
                                  event.stopPropagation()
                                  props.setSessionsCollapsed([id], expanded())
                                }
                              : undefined
                          }
                        >
                          <b>
                            {id ? (expanded() ? "▼ " : "▶ ") : ""}
                            {group.label}
                          </b>
                          <Show when={!expanded()}>
                            <span style={{ fg: theme.text.muted }}> ({group.files.length})</span>
                          </Show>
                        </text>
                        <Show when={expanded()}>
                          <For each={group.files}>
                            {(file) => (
                              <box flexDirection="row" width="100%" gap={1}>
                                <text
                                  fg="white"
                                  bg={props.context.themeMode === "light" ? "#303030" : undefined}
                                  width={3}
                                  height={1}
                                  flexShrink={0}
                                >
                                  [{marker[file.status]}]
                                </text>
                                <text
                                  fg={theme.markdown.linkText}
                                  attributes={TextAttributes.UNDERLINE}
                                  wrapMode="char"
                                  flexGrow={1}
                                  flexShrink={1}
                                  minWidth={0}
                                  selectable={false}
                                  onMouseUp={(event) => {
                                    if (event.button !== MouseButton.LEFT || event.isDragging) return
                                    event.stopPropagation()
                                    const link: FileLink = { root: tree.root, file: file.file, sessionID: props.sessionID }
                                    ui.router.navigate({ type: "plugin", name: "file-diff", data: link })
                                  }}
                                >
                                  {displayPath(file.file)}
                                </text>
                              </box>
                            )}
                          </For>
                        </Show>
                      </box>
                    )
                  }}
                </For>
              </box>
            )}
          </For>
        </Show>
      </box>
    </Show>
  )
}

/** Open the selected file in its worktree without changing the session's location. */
function FileDiff(props: { context: Plugin.Context; link: FileLink }) {
  const { client, keymap, theme, ui } = props.context
  const { root, file, sessionID } = props.link
  const lifetime = new AbortController()
  const [diff, { refetch }] = createResource(async () => {
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)])
    try {
      const { data } = await client.vcs.diff({ location: { directory: root }, mode: "working", context: 3 }, { signal })
      return { file: data.find((entry) => entry.file === file) }
    } catch {
      return { error: true }
    }
  })
  const close = () => ui.router.navigate({ type: "session", sessionID })
  onCleanup(() => lifetime.abort())
  keymap.layer(() => ({
    mode: "global",
    priority: 100,
    commands: [
      { bind: "escape", run: close },
      {
        bind: "r",
        run: () => {
          if (!diff.loading) void refetch()
        },
      },
    ],
  }))
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1}>
      <box flexShrink={0} paddingTop={1} paddingBottom={1}>
        <text fg={theme.text.base} wrapMode="char">
          <b>{displayPath(file)}</b>
        </text>
        <text fg={theme.text.muted} wrapMode="char">{displayPath(root)} · Uncommitted</text>
      </box>
      <Switch>
        <Match when={diff.loading}>
          <text fg={theme.text.muted}>Loading diff…</text>
        </Match>
        <Match when={diff()?.error}>
          <text fg={theme.text.feedback.error.base}>Could not read the diff. Press r to retry.</text>
        </Match>
        <Match when={diff()?.file?.patch}>
          {(patch) => (
            <scrollbox flexGrow={1} minHeight={0} focused>
              <text fg={theme.text.base} wrapMode="char">{patch()}</text>
            </scrollbox>
          )}
        </Match>
        <Match when={diff()?.file}>
          <text fg={theme.text.muted}>This file has no text patch.</text>
        </Match>
        <Match when={diff.state === "ready"}>
          <text fg={theme.text.muted}>This file no longer has an uncommitted diff in this worktree.</text>
        </Match>
      </Switch>
      <text fg={theme.text.muted} flexShrink={0} paddingTop={1}>
        Esc back · r reload
      </text>
    </box>
  )
}

export default Plugin.define({
  id: "sidebar-git-diff",
  setup(context) {
    const [editIndex, updateIndex] = context.storage.store<EditIndex>("edit-index-v2", { initial: {} })
    const saveIndex = (updates: IndexUpdate[]) =>
      updateIndex((draft) => {
        for (const { sessionID, expectedRevision, checkpoint } of updates) {
          // Another TUI may already have advanced this session's checkpoint.
          if (draft[sessionID]?.revision !== expectedRevision) continue
          if (checkpoint) draft[sessionID] = checkpoint
          else delete draft[sessionID]
        }
      })
    const [collapsedSessions, setCollapsedSessions] = createSignal<ReadonlySet<string>>(new Set())
    function setSessionsCollapsed(sessionIDs: readonly string[], collapsed: boolean) {
      setCollapsedSessions((current) => {
        const next = new Set(current)
        for (const sessionID of sessionIDs) {
          if (collapsed) next.add(sessionID)
          else next.delete(sessionID)
        }
        return next
      })
    }
    const unregisterDiff = context.ui.router.register({
      name: "file-diff",
      render: ({ data }) =>
        typeof data?.root === "string" && typeof data.file === "string" && typeof data.sessionID === "string"
          ? <FileDiff context={context} link={{ root: data.root, file: data.file, sessionID: data.sessionID }} />
          : <text>Missing file or worktree.</text>,
    })
    const unregisterSidebar = context.ui.slot({
      append: "sidebar.content",
      render: (input) => (
        <Show keyed when={context.data.session.get(input.sessionID)?.location.directory}>
          {(directory) => (
            <Sidebar
              context={context}
              sessionID={input.sessionID}
              directory={directory}
              editIndex={editIndex}
              saveIndex={saveIndex}
              collapsedSessions={collapsedSessions}
              setSessionsCollapsed={setSessionsCollapsed}
            />
          )}
        </Show>
      ),
    })
    return () => {
      unregisterSidebar()
      unregisterDiff()
    }
  },
})
