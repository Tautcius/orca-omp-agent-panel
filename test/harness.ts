// Drives the omp extension through its public seam (the factory plus a fake omp
// ExtensionAPI) and the Orca panel through its own (panel.html in a DOM with a
// fake Orca host). Every test gets fresh temp state/plugin directories.

import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { Window } from 'happy-dom'
import orcaOmpAgentPanel from '../omp-extension/orca-omp-agent-panel.ts'

const REPO = path.resolve(import.meta.dir, '..')
export const TEMPLATE = fs.readFileSync(path.join(REPO, 'orca-plugin/panel.template.html'), 'utf8')
const DATA_PLACEHOLDER = '/*__OMP_AGENT_DATA__*/null'

// Debounce for structural writes is 150 ms; this leaves a safe margin.
export const WRITE_SETTLE_MS = 300

export const sleep = (ms: number) => Bun.sleep(ms)

export type Dirs = { root: string; state: string; plugin: string }

export function useTempDirs(): Dirs {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omp-panel-test-'))
  const dirs = { root, state: path.join(root, 'state'), plugin: path.join(root, 'plugin') }
  fs.mkdirSync(dirs.plugin, { recursive: true })
  fs.writeFileSync(path.join(dirs.plugin, 'panel.template.html'), TEMPLATE)
  process.env.ORCA_OMP_PANEL_STATE_DIR = dirs.state
  process.env.ORCA_OMP_PANEL_PLUGIN_DIR = dirs.plugin
  return dirs
}

export function removeTempDirs(dirs: Dirs): void {
  fs.rmSync(dirs.root, { recursive: true, force: true })
}

export type Entry = { id: string; type: string; customType?: string; data?: unknown; message?: unknown }

// omp session entries carry unique ids; HUD state entries point at them.
let entrySeq = 0
const nextId = () => `e${++entrySeq}`

export type OmpOptions = {
  sessionId: string
  kind?: 'main' | 'sub'
  /** Orca terminal handle; null = omp not started from an Orca terminal. */
  terminal?: string | null
  title?: string | null
  branch?: Entry[]
}

// One omp session binding (the main session or one subagent session).
export class FakeOmp {
  readonly #handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>()
  readonly #bus = new Map<string, Array<(data: unknown) => void>>()
  sessionId: string
  title: string | null
  branch: Entry[]
  leafId = 0
  readonly ctx: object

  constructor(options: OmpOptions) {
    this.sessionId = options.sessionId
    this.title = options.title ?? null
    this.branch = options.branch ?? []
    const terminal = options.terminal === undefined ? 'term_A' : options.terminal
    // The extension captures the terminal handle when it opens a session file.
    if (terminal === null) delete process.env.ORCA_TERMINAL_HANDLE
    else process.env.ORCA_TERMINAL_HANDLE = terminal
    this.ctx = {
      cwd: '/work',
      agent: { kind: options.kind ?? 'main' },
      sessionManager: {
        getSessionId: () => this.sessionId,
        getSessionName: () => this.title ?? undefined,
        getLeafId: () => String(this.leafId),
        getBranch: () => this.branch,
      },
    }
    orcaOmpAgentPanel({
      on: (event, handler) => {
        const list = this.#handlers.get(event) ?? []
        list.push(handler as (event: unknown, ctx: unknown) => void)
        this.#handlers.set(event, list)
      },
      events: {
        on: (channel, handler) => {
          const list = this.#bus.get(channel) ?? []
          list.push(handler)
          this.#bus.set(channel, list)
        },
      },
      logger: { warn: () => {} },
    })
  }

  emit(event: string, payload?: unknown): void {
    for (const handler of this.#handlers.get(event) ?? []) handler(payload, this.ctx)
  }

  publish(channel: 'task:subagent:lifecycle' | 'task:subagent:progress', data: unknown): void {
    for (const handler of this.#bus.get(channel) ?? []) handler(data)
  }

  /** Appends a session entry and moves the leaf, like `/todo` edits do. */
  append(entry: Entry): void {
    this.branch.push(entry)
    this.leafId++
  }

  start(): this {
    this.emit('session_start')
    return this
  }

  shutdown(): void {
    this.emit('session_shutdown')
  }
}

export function todoResult(phases: unknown, extra: { op?: string; isError?: boolean } = {}): Entry {
  return {
    id: nextId(),
    type: 'message',
    message: { role: 'toolResult', toolName: 'todo', isError: extra.isError ?? false, details: { op: extra.op ?? 'update', phases } },
  }
}

export function todoEdit(phases: unknown): Entry {
  return { id: nextId(), type: 'custom', customType: 'user_todo_edit', data: { phases } }
}

/** What omp appends when its todo HUD hides (or re-shows) a finished snapshot. */
export function hudState(snapshot: Entry, visibility: 'dismissed' | 'revealed'): Entry {
  return { id: nextId(), type: 'custom', customType: 'todo_hud_state', data: { sourceEntryId: snapshot.id, fingerprint: 'fp', visibility } }
}

export function lifecycle(id: string, status: string, extra: Record<string, unknown> = {}) {
  return { id, agent: 'scout', status, description: `${id} task`, ...extra }
}

export function progress(id: string, fields: Record<string, unknown> = {}, outer: Record<string, unknown> = {}) {
  return { agent: 'scout', ...outer, progress: { id, agent: 'scout', status: 'running', ...fields } }
}

export function stateFile(dirs: Dirs, sessionId: string): string {
  return path.join(dirs.state, `${sessionId}.json`)
}

export function readState(dirs: Dirs, sessionId: string): any {
  return JSON.parse(fs.readFileSync(stateFile(dirs, sessionId), 'utf8'))
}

export function writeState(dirs: Dirs, state: Record<string, unknown>): void {
  fs.mkdirSync(dirs.state, { recursive: true })
  const full = {
    version: 1,
    pid: process.pid,
    worktreeId: null,
    paneKey: null,
    cwd: '/work',
    title: null,
    status: 'idle',
    updatedAt: Date.now(),
    todoPhases: [],
    subagents: [],
    ...state,
  }
  fs.writeFileSync(stateFile(dirs, String(state.sessionId)), JSON.stringify(full))
}

export function panelPath(dirs: Dirs): string {
  return path.join(dirs.plugin, 'panel.html')
}

/** The data the extension embedded into panel.html. */
export function panelData(dirs: Dirs): { sessions: any[] } {
  const html = fs.readFileSync(panelPath(dirs), 'utf8')
  const match = /var DATA = (.*)\n/.exec(html)
  if (!match) throw new Error('panel.html carries no DATA line')
  return JSON.parse(match[1])
}

/**
 * Forces a synchronous panel render: ending a session renders at once. The
 * helper session has no terminal, so it never shows up in the panel itself.
 */
let renderSeq = 0
export function renderPanel(): void {
  const helper = new FakeOmp({ sessionId: `zz-render-${++renderSeq}`, terminal: null }).start()
  helper.shutdown()
}

/** A pid that is certainly not running. */
export function deadPid(): number {
  return Bun.spawnSync({ cmd: ['true'] }).pid
}

// ---------------------------------------------------------------------------
// Panel DOM
// ---------------------------------------------------------------------------

export type PanelHost = { terminals?: string[]; error?: string }

export function panelHtml(sessions: unknown[]): string {
  return TEMPLATE.replace(DATA_PLACEHOLDER, () => JSON.stringify({ sessions }))
}

export type MountedPanel = { window: Window; document: Window['document']; close: () => Promise<void> }

/** Loads panel.html as Orca would: in a frame whose parent answers `workspace.readContext`. */
export async function mountPanel(html: string, host: PanelHost | null): Promise<MountedPanel> {
  const window = new Window({
    settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true },
  })
  const parent = {
    postMessage(message: { requestId: string; action: string }) {
      if (!host || message.action !== 'workspace.readContext') return
      const result = host.error
        ? { ok: false, error: host.error }
        : { ok: true, value: { terminals: (host.terminals ?? []).map((id) => ({ id })) } }
      queueMicrotask(() =>
        window.dispatchEvent(
          new window.MessageEvent('message', {
            data: { type: 'orca-panel-action-result', requestId: message.requestId, ...result },
            source: parent as never,
          }),
        ),
      )
    },
  }
  Object.defineProperty(window, 'parent', { value: parent, configurable: true })
  window.document.write(html)
  await sleep(20)
  return { window, document: window.document, close: () => window.happyDOM.close() }
}
