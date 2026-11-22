/** @jsxImportSource @opentui/solid */
import { posix, win32 } from "node:path"
import type { LocationGetOutput, SessionInfo, SessionMessageAssistantTool, VcsFileStatus } from "@opencode/client"
import { Plugin } from "@opencode/plugin/tui"
import { MouseButton, TextAttributes } from "@opentui/core"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"

const SESSION_LIMIT = 30
const PAGE_SIZE = 25
const PAGE_LIMIT = 4
const CONCURRENCY = 4
const REFRESH_MS = 10_000

type History = { edits: Map<string, number>; limited: boolean }
type SessionChanges = { session: SessionInfo; history: History }
type Scope = Pick<SessionInfo, "location" | "subpath">

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

/** Return the last recorded file-tool completion for each path in this worktree. */
async function readHistory(
  client: Plugin.Context["client"],
  session: SessionInfo,
  root: string,
  signal: AbortSignal,
): Promise<History> {
  const edits = new Map<string, number>()
  const path = serverPath(root)
  let directory = session.location.directory
  let cursor: string | undefined
  for (let page = 0; page < PAGE_LIMIT; page++) {
    const result = await client.message.list(
      { sessionID: session.id, limit: PAGE_SIZE, ...(cursor ? { cursor } : { order: "desc" }) },
      { signal },
    )
    for (const message of result.data) {
      // A fork inherits its source history. Do not count copied messages as new edits.
      if (session.fork && message.time.created < session.time.created) return { edits, limited: false }
      if (message.type === "location-switched") {
        if (!message.previous || !inWorktree(message.previous, root)) return { edits, limited: false }
        // Older tool paths are relative to the session directory before the move.
        directory = message.previous.location.directory
        continue
      }
      if (message.type === "assistant") {
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
    }
    cursor = result.cursor.next ?? undefined
    // OpenCode may return a cursor for the last non-empty page.
    if (!cursor || result.data.length < PAGE_SIZE) return { edits, limited: false }
  }
  return { edits, limited: true }
}

function displayPath(file: string) {
  return file.replaceAll(/[\x00-\x1f\x7f-\x9f]/g, "�")
}

function Sidebar(props: {
  context: Plugin.Context
  sessionID: string
  directory: string
  collapsedSessions: () => ReadonlySet<string>
  toggleSession: (sessionID: string) => void
}) {
  const { client, data, theme, ui } = props.context
  const [files, setFiles] = createSignal<VcsFileStatus[]>([])
  const [statusError, setStatusError] = createSignal(false)
  const [attribution, setAttribution] = createSignal<{ sessions: Map<string, SessionChanges>; partial: boolean }>()
  let scope: LocationGetOutput | undefined
  let cache = new Map<string, SessionChanges>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const lifetime = new AbortController()
  const tabs = createMemo(() => {
    if (!ui.tabs.enabled()) return [{ sessionID: props.sessionID, title: undefined }]
    const open = ui.tabs.list()
    const rootID = data.session.root(props.sessionID)
    return open.some((tab) => tab.sessionID === rootID) ? open : [...open, { sessionID: rootID, title: undefined }]
  })

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

    try {
      const signal = AbortSignal.any([lifetime.signal, AbortSignal.timeout(15_000)])
      const open = tabs()
      const candidates = open.slice(0, SESSION_LIMIT)
      const next = new Map<string, SessionChanges>()
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
            const previous = cache.get(session.id)
            const history =
              previous?.session.time.updated === session.time.updated
                ? previous.history
                : await readHistory(client, session, root, signal)
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
          partial ||= entry.history.limited
          next.set(entry.session.id, entry)
        }
      }
      if (lifetime.signal.aborted) return
      cache = next
      setAttribution({ sessions: next, partial })
    } catch {
      if (!lifetime.signal.aborted) setAttribution({ sessions: new Map(), partial: true })
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
  const matchStatus = () => {
    const result = attribution()
    if (!result) return "Matching sessions…"
    return result.partial ? "Recent file edits · partial history" : "Latest recorded file edits"
  }
  const marker = { added: "A", deleted: "D", modified: "M" } as const

  return (
    <Show when={statusError() || files().length > 0}>
      <box>
        <text fg={theme.text.base}>
          <b>Git changes ({files().length})</b>
        </text>
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
                                props.toggleSession(sessionID)
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
    const [collapsedSessions, setCollapsedSessions] = createSignal<ReadonlySet<string>>(new Set())
    function toggleSession(sessionID: string) {
      setCollapsedSessions((current) => {
        const next = new Set(current)
        if (!next.delete(sessionID)) next.add(sessionID)
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
              collapsedSessions={collapsedSessions}
              toggleSession={toggleSession}
            />
          )}
        </Show>
      ),
    })
  },
})
