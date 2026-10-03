// orca-omp-agent-panel: mirrors the main omp session's todo list and subagent
// status into one JSON state file per session, consumed by the Orca panel plugin.
//
// Contract: schema v1, `<stateDir>/<sessionId>.json`, written atomically
// (`<file>.<pid>.tmp` + rename), debounced/coalesced, final status `ended`.
//
// Dependency-free on purpose: no type import from @oh-my-pi so the file loads
// from any extension directory without a node_modules resolution.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

// ---------------------------------------------------------------------------
// Contract types
// ---------------------------------------------------------------------------

type TodoStatus = 'pending' | 'in_progress' | 'completed' | 'abandoned' | 'blocked'
type TodoTask = { content: string; status: TodoStatus; blocker?: string }
type TodoPhase = { name: string; tasks: TodoTask[] }
type SubagentStatus = 'running' | 'completed' | 'failed' | 'aborted'
type Subagent = {
  id: string
  agent: string
  description: string | null
  status: SubagentStatus
  startedAt: number
  endedAt: number | null
  model: string | null
}
type SessionStatus = 'working' | 'idle' | 'ended'
type StateFileV1 = {
  version: 1
  sessionId: string
  pid: number
  worktreeId: string | null
  paneKey: string | null
  cwd: string
  title: string | null
  status: SessionStatus
  updatedAt: number
  todoPhases: TodoPhase[]
  subagents: Subagent[]
}

// ---------------------------------------------------------------------------
// Minimal structural view of the omp extension API (omp docs: extensions.md)
// ---------------------------------------------------------------------------

type Logger = { warn?: (msg: string, meta?: unknown) => void }
type SessionEntry = { type?: string; customType?: string; data?: unknown; message?: unknown }
type SessionManagerView = {
  getSessionId?: () => string | undefined
  getSessionName?: () => string | undefined
  getLeafId?: () => string | null | undefined
  getBranch?: () => SessionEntry[]
  getHeader?: () => { parentSession?: unknown } | undefined
}
type Ctx = {
  cwd?: string
  sessionManager?: SessionManagerView
  agent?: { kind?: 'main' | 'sub' }
  agentKind?: string
}
// Fields this extension reads from omp hook events; every field is optional
// because one handler type covers all subscribed events.
type HookEvent = {
  willContinue?: unknown
  toolName?: unknown
  isError?: unknown
  details?: { op?: unknown; phases?: unknown }
}
type Handler = (event: HookEvent | undefined, ctx: Ctx) => unknown
type ExtensionAPI = {
  on: (event: string, handler: Handler) => void
  events?: { on?: (channel: string, handler: (data: unknown) => void) => unknown }
  logger?: Logger
}

// omp event-bus channels (packages/coding-agent/src/task/*: TASK_SUBAGENT_*_CHANNEL)
const LIFECYCLE_CHANNEL = 'task:subagent:lifecycle'
const PROGRESS_CHANNEL = 'task:subagent:progress'
// Session custom entry written by `/todo` edits and eval todo commits.
const USER_TODO_EDIT = 'user_todo_edit'

const WRITE_DEBOUNCE_MS = 150
const LEAF_POLL_MS = 1000
const LOG_PREFIX = '[orca-omp-agent-panel]'

const TODO_STATUSES: Record<TodoStatus, true> = {
  pending: true,
  in_progress: true,
  completed: true,
  abandoned: true,
  blocked: true,
}

function normalizePhases(raw: unknown): TodoPhase[] | undefined {
  if (!Array.isArray(raw)) return undefined
  const phases: TodoPhase[] = []
  for (const phase of raw) {
    if (!phase || typeof phase !== 'object') continue
    const p = phase as { name?: unknown; tasks?: unknown }
    const tasks: TodoTask[] = []
    if (Array.isArray(p.tasks)) {
      for (const task of p.tasks) {
        if (!task || typeof task !== 'object') continue
        const t = task as { content?: unknown; status?: unknown; blocker?: unknown }
        if (typeof t.content !== 'string') continue
        const status: TodoStatus = typeof t.status === 'string' && t.status in TODO_STATUSES ? (t.status as TodoStatus) : 'pending'
        const item: TodoTask = { content: t.content, status }
        if (typeof t.blocker === 'string' && t.blocker) item.blocker = t.blocker
        tasks.push(item)
      }
    }
    phases.push({ name: typeof p.name === 'string' ? p.name : '', tasks })
  }
  return phases
}

// Mirrors omp's own restore rule (session/todo-tracker.ts): the latest
// `user_todo_edit` custom entry or successful non-`view` `todo` tool result wins.
function latestPhasesFromBranch(branch: SessionEntry[] | undefined): TodoPhase[] {
  if (!Array.isArray(branch)) return []
  for (let i = branch.length - 1; i >= 0; i--) {
    const entry = branch[i]
    let phases: TodoPhase[] | undefined
    if (entry.type === 'custom' && entry.customType === USER_TODO_EDIT) {
      phases = normalizePhases((entry.data as { phases?: unknown } | undefined)?.phases)
    } else if (entry.type === 'message') {
      const msg = entry.message as
        | { role?: string; toolName?: string; isError?: boolean; details?: { op?: string; phases?: unknown } }
        | undefined
      if (msg?.role === 'toolResult' && msg.toolName === 'todo' && !msg.isError && msg.details?.op !== 'view') {
        phases = normalizePhases(msg.details?.phases)
      }
    }
    if (phases) return phases
  }
  return []
}

// ---------------------------------------------------------------------------
// Per-session state file writer
// ---------------------------------------------------------------------------

class SessionStateFile {
  readonly state: StateFileV1
  #timer: NodeJS.Timeout | undefined
  #ended = false
  readonly #logger: Logger | undefined

  constructor(sessionId: string, cwd: string, logger: Logger | undefined) {
    this.#logger = logger
    this.state = {
      version: 1,
      sessionId,
      pid: process.pid,
      worktreeId: process.env.ORCA_WORKTREE_ID || null,
      paneKey: process.env.ORCA_PANE_KEY || null,
      cwd,
      title: null,
      status: 'idle',
      updatedAt: Date.now(),
      todoPhases: [],
      subagents: [],
    }
  }

  get ended(): boolean {
    return this.#ended
  }

  // Debounced + coalesced: the timer reads `this.state` at fire time, so the latest state wins.
  schedule(): void {
    if (this.#ended || this.#timer !== undefined) return
    this.#timer = setTimeout(() => {
      this.#timer = undefined
      this.#flush()
    }, WRITE_DEBOUNCE_MS)
    this.#timer.unref?.()
  }

  // Synchronous final write so it lands even while the process is exiting.
  end(): void {
    if (this.#ended) return
    clearTimeout(this.#timer)
    this.#timer = undefined
    const now = Date.now()
    for (const sub of this.state.subagents) {
      if (sub.status === 'running') {
        sub.status = 'aborted'
        sub.endedAt = now
      }
    }
    this.state.status = 'ended'
    this.#flush()
    this.#ended = true
  }

  // Writes are synchronous (small file, at most one per debounce window) so an
  // in-flight async rename can never overwrite the final `ended` snapshot.
  #flush(): void {
    if (this.#ended) return
    try {
      // Orca plugin workers only see HOME, so XDG_STATE_HOME is deliberately ignored.
      const dir = process.env.ORCA_OMP_PANEL_STATE_DIR || path.join(os.homedir(), '.local/state/orca-omp-agent-panel/sessions')
      const file = path.join(dir, `${this.state.sessionId.replace(/[^A-Za-z0-9._-]/g, '_')}.json`)
      const tmp = `${file}.${process.pid}.tmp`
      this.state.updatedAt = Date.now()
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(this.state, null, 2))
      fs.renameSync(tmp, file)
    } catch (error) {
      try {
        this.#logger?.warn?.(`${LOG_PREFIX} failed to write state file`, {
          sessionId: this.state.sessionId,
          error: error instanceof Error ? error.message : String(error),
        })
      } catch {}
    }
  }
}

// ---------------------------------------------------------------------------
// Process-wide plumbing (module scope is shared by main and child bindings)
// ---------------------------------------------------------------------------

// The main binding's bus handler. Sub-session bindings forward their own
// children's events here so nested subagents (depth >= 2) are visible too: omp
// emits a spawn's events on the spawning session's bus, not the main one.
let activeMainSink: ((channel: string, data: unknown) => void) | null = null

const liveFiles = new Set<SessionStateFile>()
let exitHookInstalled = false
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.once('exit', () => {
    for (const file of liveFiles) {
      try {
        file.end()
      } catch {}
    }
    liveFiles.clear()
  })
}

// ---------------------------------------------------------------------------
// Extension factory (runs once per session binding: main + every subagent)
// ---------------------------------------------------------------------------

export default function orcaOmpAgentPanel(pi: ExtensionAPI): void {
  const logger = pi.logger
  let kind: 'main' | 'sub' | undefined
  let current: SessionStateFile | null = null
  let lastCtx: Ctx | null = null
  let lastLeafId: string | null | undefined
  let leafPoll: NodeJS.Timeout | undefined

  function log(msg: string, error: unknown): void {
    try {
      logger?.warn?.(`${LOG_PREFIX} ${msg}`, { error: error instanceof Error ? error.message : String(error) })
    } catch {}
  }

  function resolveKind(ctx: Ctx): 'main' | 'sub' {
    if (kind) return kind
    const k = ctx.agent?.kind ?? ctx.agentKind
    if (k === 'main' || k === 'sub') kind = k
    // Older hosts without ctx.agent: task transcripts carry a parentSession header.
    else kind = typeof ctx.sessionManager?.getHeader?.()?.parentSession === 'string' ? 'sub' : 'main'
    return kind
  }

  function refreshTodosFromBranch(ctx: Ctx): void {
    if (!current) return
    lastLeafId = ctx.sessionManager?.getLeafId?.()
    current.state.todoPhases = latestPhasesFromBranch(ctx.sessionManager?.getBranch?.())
  }

  function refreshMeta(ctx: Ctx): void {
    if (!current) return
    if (typeof ctx.cwd === 'string' && ctx.cwd) current.state.cwd = ctx.cwd
    const name = ctx.sessionManager?.getSessionName?.()
    current.state.title = typeof name === 'string' && name.trim() ? name : null
  }

  function finalizeCurrent(): void {
    if (!current) return
    current.end()
    liveFiles.delete(current)
    current = null
  }

  // Binds `current` to the ctx's session id; a changed id (switch/new/resume/fork)
  // finalizes the previous file as ended and starts a fresh one.
  function sync(ctx: Ctx): SessionStateFile | null {
    lastCtx = ctx
    if (resolveKind(ctx) !== 'main') return null
    const sessionId = ctx.sessionManager?.getSessionId?.()
    if (typeof sessionId !== 'string' || !sessionId) return current
    if (!current || current.state.sessionId !== sessionId) {
      finalizeCurrent()
      current = new SessionStateFile(sessionId, ctx.cwd ?? process.cwd(), logger)
      liveFiles.add(current)
      installExitHook()
      activeMainSink = onBusEvent
      refreshTodosFromBranch(ctx)
      startLeafPoll()
    }
    refreshMeta(ctx)
    return current
  }

  // `/todo` edits and eval todo commits only append a `user_todo_edit` entry and
  // emit no extension event, so watch the session leaf and rescan when it moves.
  function startLeafPoll(): void {
    if (leafPoll !== undefined) return
    leafPoll = setInterval(() => {
      try {
        const ctx = lastCtx
        if (!current || !ctx) return
        if (ctx.sessionManager?.getLeafId?.() === lastLeafId) return
        const before = JSON.stringify(current.state.todoPhases)
        const beforeTitle = current.state.title
        refreshTodosFromBranch(ctx)
        refreshMeta(ctx)
        if (JSON.stringify(current.state.todoPhases) !== before || current.state.title !== beforeTitle) current.schedule()
      } catch (error) {
        log('leaf poll failed', error)
      }
    }, LEAF_POLL_MS)
    leafPoll.unref?.()
  }

  function setStatus(ctx: Ctx, status: 'working' | 'idle'): void {
    const file = sync(ctx)
    if (!file) return
    file.state.status = status
    file.schedule()
  }

  function upsertSubagent(file: SessionStateFile, id: string, agent: unknown, description: unknown): Subagent {
    let sub = file.state.subagents.find((s) => s.id === id)
    if (!sub) {
      sub = {
        id,
        agent: 'unknown',
        description: null,
        status: 'running',
        startedAt: Date.now(),
        endedAt: null,
        model: null,
      }
      file.state.subagents.push(sub)
    }
    if (typeof agent === 'string' && agent) sub.agent = agent
    if (typeof description === 'string' && description.trim()) sub.description = description
    return sub
  }

  // Lifecycle payload (task/executor.ts; also eval agent() and workpool spawns):
  //   { id, agent, parentToolCallId, detached, agentSource, description,
  //     status: 'started'|'completed'|'failed'|'aborted', sessionFile, index }
  // Progress payload (task/executor.ts, coalesced ~150ms):
  //   { index, agent, agentSource, task, parentToolCallId, detached, assignment, sessionFile,
  //     progress: { id, agent, status, description, resolvedModel?, modelOverride?, ... } }
  function onBusEvent(channel: string, data: unknown): void {
    if (kind === 'sub') {
      activeMainSink?.(channel, data)
      return
    }
    const file = current
    if (!file || file.ended || !data || typeof data !== 'object') return
    const ev = data as Record<string, unknown>
    if (channel === LIFECYCLE_CHANNEL) {
      if (typeof ev.id !== 'string' || !ev.id) return
      const status = ev.status
      if (status !== 'started' && status !== 'completed' && status !== 'failed' && status !== 'aborted') return
      const sub = upsertSubagent(file, ev.id, ev.agent, ev.description)
      if (status === 'started') {
        sub.status = 'running'
        sub.startedAt = Date.now()
        sub.endedAt = null
      } else {
        sub.status = status
        sub.endedAt = Date.now()
      }
      file.schedule()
      return
    }
    if (channel !== PROGRESS_CHANNEL || !ev.progress || typeof ev.progress !== 'object') return
    const p = ev.progress as Record<string, unknown>
    if (typeof p.id !== 'string' || !p.id) return
    const known = file.state.subagents.find((s) => s.id === p.id)
    // A progress tick for an unknown id only registers it while it is still running.
    if (!known && p.status !== 'running') return
    const sub = known ?? upsertSubagent(file, p.id, p.agent ?? ev.agent, p.description)
    let changed = !known
    const model =
      typeof p.resolvedModel === 'string' && p.resolvedModel
        ? p.resolvedModel
        : typeof p.modelOverride === 'string' && p.modelOverride
          ? p.modelOverride
          : null
    if (model && sub.model !== model) {
      sub.model = model
      changed = true
    }
    if (!sub.description && typeof p.description === 'string' && p.description.trim()) {
      sub.description = p.description
      changed = true
    }
    if (changed) file.schedule()
  }

  // Event-bus listeners run outside handler dispatch isolation: never let them throw.
  if (typeof pi.events?.on === 'function') {
    try {
      for (const channel of [LIFECYCLE_CHANNEL, PROGRESS_CHANNEL]) {
        pi.events.on(channel, (data) => {
          try {
            onBusEvent(channel, data)
          } catch (error) {
            log(`${channel} listener failed`, error)
          }
        })
      }
    } catch (error) {
      log('event bus subscribe failed', error)
    }
  }

  function on(event: string, fn: Handler): void {
    pi.on(event, (ev, ctx) => {
      try {
        fn(ev, ctx)
      } catch (error) {
        log(`${event} handler failed`, error)
      }
    })
  }

  on('session_start', (_ev, ctx) => {
    sync(ctx)?.schedule()
  })

  // Branch/tree navigation restores a different todo snapshot; switch/new/resume/fork
  // change the session id, which `sync` turns into an ended file plus a new one.
  for (const event of ['session_switch', 'session_branch', 'session_tree']) {
    on(event, (_ev, ctx) => {
      const file = sync(ctx)
      if (!file) return
      refreshTodosFromBranch(ctx)
      file.schedule()
    })
  }

  on('agent_start', (_ev, ctx) => setStatus(ctx, 'working'))
  on('turn_start', (_ev, ctx) => setStatus(ctx, 'working'))
  on('tool_execution_start', (_ev, ctx) => setStatus(ctx, 'working'))

  // `willContinue` marks non-terminal ends (retries, follow-ups, awaiting async
  // subagents); only a terminal end means the agent is idle.
  on('agent_end', (ev, ctx) => {
    if (ev?.willContinue === true) {
      setStatus(ctx, 'working')
      return
    }
    const file = sync(ctx)
    if (!file) return
    refreshTodosFromBranch(ctx)
    file.state.status = 'idle'
    file.schedule()
  })

  // Picks up a session title generated mid-turn.
  on('turn_end', (_ev, ctx) => {
    sync(ctx)?.schedule()
  })

  // details.phases on a successful, non-`view` todo result is the canonical snapshot.
  on('tool_result', (ev, ctx) => {
    if (ev?.toolName !== 'todo' || ev.isError || ev.details?.op === 'view') return
    const phases = normalizePhases(ev.details?.phases)
    if (!phases) return
    const file = sync(ctx)
    if (!file) return
    file.state.todoPhases = phases
    file.schedule()
  })

  on('session_shutdown', (_ev, ctx) => {
    if (resolveKind(ctx) !== 'main') return
    clearInterval(leafPoll)
    leafPoll = undefined
    if (current) refreshMeta(ctx)
    finalizeCurrent()
    if (activeMainSink === onBusEvent) activeMainSink = null
  })
}
