/** @jsxImportSource @opentui/solid */
import { execFile } from "node:child_process"
import { randomUUID } from "node:crypto"
import { posix, win32 } from "node:path"
import type { LocationGetOutput, SessionInfo, SessionMessageAssistantTool, VcsFileStatus } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import { MouseButton, TextAttributes } from "@opentui/core"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { unwrap } from "solid-js/store"

const SESSION_LIMIT = 30
const PAGE_SIZE = 50
const PAGES_PER_REFRESH = 4
const CONCURRENCY = 4
const REFRESH_MS = 10_000

type History = { edits: ReadonlyMap<string, number>; partial: boolean }
type SessionChanges = { session: SessionInfo; history: History }
type Scope = Pick<SessionInfo, "location" | "subpath">
type Checkpoint = {
  revision: string
  scope: string
  directory: string | null
  position?: { cursor: string; messageID: string }
  edits: [string, number][]
  synced?: { updated: number; idle?: number }
}
type EditIndex = Record<string, Checkpoint | undefined>
type IndexUpdate = { sessionID: string; expectedRevision?: string; checkpoint?: Checkpoint }

function serverPath(root: string) {
  return root.startsWith("/") ? posix : win32
}

/** Compare worktree roots using server paths, including when the client runs on a different OS. */
function inWorktree(scope: Scope, root: string) {
  const path = serverPath(root)
  const subpath = path.relative(root, scope.location.directory).split(path.sep).join("/")
  return (
    !subpath ||
    (subpath === scope.subpath && !subpath.startsWith("../") && subpath !== ".." && !path.isAbsolute(subpath))
  )
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

/** Resume after the last settled page. An active assistant message can still gain tool results. */
async function readHistory(
  client: Plugin.Context["client"],
  session: SessionInfo,
  root: string,
  previous: Checkpoint | undefined,
  signal: AbortSignal,
): Promise<History & { checkpoint?: Checkpoint }> {
  const scope = JSON.stringify([session.projectID, root, session.time.created])
  let checkpoint = previous?.scope === scope ? previous : undefined
  let position = checkpoint?.position
  let directory = checkpoint?.directory
  const edits = new Map(checkpoint?.edits)
  const path = serverPath(root)
  const { updated, idle, busy } = session.time
  if (checkpoint?.synced?.updated === updated && checkpoint.synced.idle === idle && (busy ?? 0) <= (idle ?? 0)) {
    return { edits, checkpoint, partial: false }
  }

  function directoryInWorktree(place: (Scope & { projectID?: SessionInfo["projectID"] }) | null | undefined) {
    return place && (!place.projectID || place.projectID === session.projectID) && inWorktree(place, root)
      ? place.location.directory
      : null
  }

  try {
    for (let page = 0; page < PAGES_PER_REFRESH; page++) {
      if (directory === undefined) {
        const { data: [firstMove] } = await client.message.list(
          { sessionID: session.id, order: "asc", type: "location-switched", limit: 1 },
          { signal },
        )
        directory =
          firstMove?.type === "location-switched" ? directoryInWorktree(firstMove.previous) : session.location.directory
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
          directory = directoryInWorktree(message)
          // A return to this worktree starts a new attribution span.
          if (!directory) edits.clear()
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
            const relative = path.relative(root, path.resolve(directory, resource))
            const file = relative.split(path.sep).join("/")
            if (!file || file === ".." || file.startsWith("../") || path.isAbsolute(relative)) continue
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
  const [files, setFiles] = createSignal<VcsFileStatus[]>([])
  const [statusError, setStatusError] = createSignal(false)
  const [worktreeStatus, setWorktreeStatus] = createSignal<string>()
  const [attribution, setAttribution] = createSignal<{ sessions: Map<string, SessionChanges>; partial: boolean }>()
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

  async function refreshWorktreeStatus(root: string) {
    const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(3_000)])
    const vcs = await client.vcs
      .get({ location: { directory: root } }, { signal })
      .then(({ data }) => data, () => undefined)
    const branch = vcs?.branch.current
    let ahead = "?"
    if (vcs?.provider === "git" && !branch) ahead = "-"
    if (vcs?.provider === "git" && branch && local) ahead = await readAhead(root, branch, signal)
    const worktree = serverPath(root).basename(root) || root
    const branchLabel = branch ?? (vcs?.provider === "git" ? "detached HEAD" : "branch unavailable")
    if (!lifetime.signal.aborted) setWorktreeStatus(`${displayPath(worktree)} · ${displayPath(branchLabel)} (${ahead})`)
  }

  async function refresh() {
    let root: string
    try {
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(10_000)])
      scope ??= await client.location.get({ location: { directory: props.directory } }, { signal })
      root = scope.project.directory
      const { data } = await client.vcs.status({ location: { directory: root } }, { signal })
      if (lifetime.signal.aborted) return
      setStatusError(false)
      setFiles(data)
      if (!data.length) return
    } catch {
      if (lifetime.signal.aborted) return
      setFiles([])
      setStatusError(true)
      return
    }

    const branchStatus = refreshWorktreeStatus(root)
    try {
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)])
      const open = tabs()
      const candidates = open.slice(0, SESSION_LIMIT)
      const next = new Map<string, SessionChanges>()
      const updates: IndexUpdate[] = []
      let partial = open.length > candidates.length
      for (let offset = 0; offset < candidates.length; offset += CONCURRENCY) {
        if (signal.aborted) {
          partial = true
          break
        }
        const results = await Promise.allSettled(
          candidates.slice(offset, offset + CONCURRENCY).map(async ({ sessionID }) => {
            const session = await client.session.get({ sessionID }, { signal })
            if (session.projectID !== scope?.project.id || !inWorktree(session, root)) return
            const stored = props.editIndex[session.id]
            // Storage can update while an API read is in flight.
            const before = stored && structuredClone(unwrap(stored))
            const history = await readHistory(client, session, root, before, signal)
            if (before?.revision !== history.checkpoint?.revision) {
              updates.push({ sessionID: session.id, expectedRevision: before?.revision, checkpoint: history.checkpoint })
            }
            return { session, history }
          }),
        )
        for (const result of results) {
          if (result.status === "rejected") {
            partial = true
            continue
          }
          const entry = result.value
          if (!entry) continue
          partial ||= entry.history.partial
          next.set(entry.session.id, entry)
        }
      }
      if (lifetime.signal.aborted) return
      setAttribution({ sessions: next, partial })
      if (updates.length) {
        await props.saveIndex(updates).catch(() => {
          if (!lifetime.signal.aborted) setAttribution({ sessions: next, partial: true })
        })
      }
    } catch {
      if (!lifetime.signal.aborted) setAttribution({ sessions: new Map(), partial: true })
    } finally {
      await branchStatus
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

  const groups = createMemo(() => {
    const open = tabs()
    const records = attribution()?.sessions
    const byTab = new Map<string | undefined, VcsFileStatus[]>()
    for (const file of files()) {
      let owner: string | undefined
      let latest = -Infinity
      for (const tab of open) {
        const time = records?.get(tab.sessionID)?.history.edits.get(file.file)
        if (time === undefined || time < latest) continue
        // Do not pick an owner when two tabs report the same completion time.
        owner = time === latest ? undefined : tab.sessionID
        latest = time
      }
      const changes = byTab.get(owner) ?? []
      changes.push(file)
      byTab.set(owner, changes)
    }
    const sessions = open.flatMap((tab) => {
      const changes = byTab.get(tab.sessionID)
      if (!changes) return []
      const label = data.session.get(tab.sessionID)?.title ?? tab.title ?? records?.get(tab.sessionID)?.session.title
      return [{ sessionID: tab.sessionID, label: label || tab.sessionID, files: changes }]
    })
    const unknown = byTab.get(undefined)
    const label = attribution() ? "Unassigned" : "Awaiting match"
    return unknown ? [...sessions, { sessionID: undefined, label, files: unknown }] : sessions
  })
  const sessionGroupIDs = createMemo(() => groups().flatMap(({ sessionID }) => (sessionID ? [sessionID] : [])))
  const canToggleAll = () => !statusError() && sessionGroupIDs().length > 0
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
  const matchStatus = () => {
    const result = attribution()
    if (!result) return "Matching sessions…"
    return result.partial ? "Indexed file edits · partial history" : "Latest recorded file edits"
  }
  const marker = { added: "A", deleted: "D", modified: "M" } as const

  return (
    <Show when={statusError() || files().length > 0}>
      <box>
        <box flexDirection="row" justifyContent="space-between" gap={1}>
          <text fg={theme.text.base} wrapMode="word" flexShrink={1} minWidth={0}>
            <b>Git changes ({files().length})</b>
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
        <Show
          when={statusError()}
          fallback={
            <>
              <text fg={theme.text.muted} wrapMode="word">
                {matchStatus()}
              </text>
              <For each={groups()}>
                {(group) => {
                  const sessionID = group.sessionID
                  const expanded = () => !sessionID || !props.collapsedSessions().has(sessionID)
                  return (
                    <box marginTop={1}>
                      <text
                        fg={theme.text.base}
                        wrapMode="char"
                        selectable={!sessionID}
                        onMouseUp={
                          sessionID
                            ? (event) => {
                                if (event.button !== MouseButton.LEFT || event.isDragging) return
                                event.stopPropagation()
                                props.setSessionsCollapsed([sessionID], expanded())
                              }
                            : undefined
                        }
                      >
                        <b>
                          {sessionID ? (expanded() ? "▼ " : "▶ ") : ""}
                          {group.label}
                        </b>
                        <Show when={!expanded()}>
                          <span style={{ fg: theme.text.muted }}> ({group.files.length})</span>
                        </Show>
                      </text>
                      <Show when={sessionID && worktreeStatus()}>
                        <text fg={theme.text.muted} wrapMode="word">
                          {worktreeStatus()}
                        </text>
                      </Show>
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
                                  const sessionID = props.sessionID
                                  // OpenCode 2.3.2 accepts a diff source here, but no initial file.
                                  ui.router.navigate({
                                    type: "plugin",
                                    id: "opencode.diffs",
                                    name: "diff",
                                    data: { mode: "working", sessionID, returnRoute: { type: "session", sessionID } },
                                  })
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
            </>
          }
        >
          <text fg={theme.text.feedback.error.base} wrapMode="word">
            Could not read Git status.
          </text>
        </Show>
      </box>
    </Show>
  )
}

export default Plugin.define({
  id: "sidebar-git-diff",
  setup(context) {
    const [editIndex, updateIndex] = context.storage.store<EditIndex>("edit-index-v1", { initial: {} })
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
    return context.ui.slot({
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
  },
})
