// Orca plugin worker: watches the state files written by the omp extension
// (omp-extension/orca-omp-agent-panel.ts) and publishes a snapshot of every
// live session to the "agent" panel. The panel filters by the focused
// worktree, so the worker never needs to know which worktree is on screen.
//
// Runs in Orca's out-of-process worker (plain Node, scrubbed env: only HOME
// and a few locale vars survive), so the state dir is derived from HOME.

import { mkdirSync, readdirSync, readFileSync, unlinkSync, watch } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const PANEL_ID = 'agent'
const STATE_DIR = join(homedir(), '.local/state/orca-omp-agent-panel/sessions')
// Ended sessions stay visible briefly so the final todo state can be read.
const ENDED_VISIBLE_MS = 10 * 60_000
// Files of long-dead sessions are deleted so the directory does not grow forever.
const STALE_DELETE_MS = 24 * 60 * 60_000
const RESCAN_INTERVAL_MS = 5_000
const DEBOUNCE_MS = 100

const TODO_STATUSES = new Set(['pending', 'in_progress', 'completed', 'abandoned', 'blocked'])
const SUBAGENT_STATUSES = new Set(['running', 'completed', 'failed', 'aborted'])

function str(value) {
  return typeof value === 'string' ? value : null
}

function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return error?.code === 'EPERM'
  }
}

function parseTodoPhases(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((phase) => phase && typeof phase === 'object')
    .map((phase) => ({
      name: str(phase.name) ?? '',
      tasks: (Array.isArray(phase.tasks) ? phase.tasks : [])
        .filter((task) => task && typeof task === 'object' && TODO_STATUSES.has(task.status))
        .map((task) => ({
          content: str(task.content) ?? '',
          status: task.status,
          blocker: str(task.blocker)
        }))
    }))
}

function parseSubagents(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((sub) => sub && typeof sub === 'object' && SUBAGENT_STATUSES.has(sub.status))
    .map((sub) => ({
      id: str(sub.id) ?? '',
      agent: str(sub.agent) ?? 'task',
      description: str(sub.description),
      status: sub.status,
      startedAt: num(sub.startedAt),
      endedAt: num(sub.endedAt),
      model: str(sub.model)
    }))
}

/** Validates one state file (schema v1). Returns null for foreign or broken files. */
function parseSession(text) {
  let raw
  try {
    raw = JSON.parse(text)
  } catch {
    return null
  }
  if (!raw || raw.version !== 1 || !str(raw.sessionId)) return null
  return {
    sessionId: raw.sessionId,
    pid: num(raw.pid),
    worktreeId: str(raw.worktreeId),
    cwd: str(raw.cwd),
    title: str(raw.title),
    status: raw.status === 'working' || raw.status === 'idle' ? raw.status : 'ended',
    updatedAt: num(raw.updatedAt) ?? 0,
    todoPhases: parseTodoPhases(raw.todoPhases),
    subagents: parseSubagents(raw.subagents)
  }
}

function readSessions(now, log) {
  let names
  try {
    names = readdirSync(STATE_DIR)
  } catch {
    return []
  }
  const sessions = []
  for (const name of names) {
    if (!name.endsWith('.json')) continue
    const file = join(STATE_DIR, name)
    let session
    try {
      session = parseSession(readFileSync(file, 'utf8'))
    } catch {
      continue // Raced with the writer's rename or a delete.
    }
    if (!session) continue
    // A crashed omp never writes "ended"; a dead pid is the only signal.
    if (session.status !== 'ended' && session.pid !== null && !isPidAlive(session.pid)) {
      session.status = 'ended'
    }
    const age = now - session.updatedAt
    if (session.status === 'ended' && age > STALE_DELETE_MS) {
      try {
        unlinkSync(file)
      } catch (error) {
        log(`could not delete stale ${name}: ${error?.message ?? error}`)
      }
      continue
    }
    if (session.status === 'ended' && age > ENDED_VISIBLE_MS) continue
    sessions.push(session)
  }
  sessions.sort((a, b) => b.updatedAt - a.updatedAt)
  return sessions
}

let watcher = null
let interval = null
let debounce = null

export default function activate(orca) {
  if (typeof orca.panels?.publish !== 'function') {
    orca.log('this Orca build has no orca.panels.publish; the panel cannot receive data')
    return
  }
  try {
    mkdirSync(STATE_DIR, { recursive: true })
  } catch (error) {
    orca.log(`cannot create ${STATE_DIR}: ${error?.message ?? error}`)
  }

  let lastPublished = ''
  const publish = () => {
    // Why: this runs from timers; an escaped throw kills the whole worker.
    try {
      const snapshot = { stateDir: STATE_DIR, sessions: readSessions(Date.now(), orca.log) }
      const serialized = JSON.stringify(snapshot.sessions)
      if (serialized === lastPublished) return
      lastPublished = serialized
      orca.panels.publish(PANEL_ID, snapshot)
    } catch (error) {
      orca.log(`publish failed: ${error?.message ?? error}`)
    }
  }
  const schedule = () => {
    if (debounce) return
    debounce = setTimeout(() => {
      debounce = null
      publish()
    }, DEBOUNCE_MS)
  }

  try {
    watcher = watch(STATE_DIR, schedule)
    watcher.on('error', (error) => orca.log(`watch error: ${error?.message ?? error}`))
  } catch (error) {
    orca.log(`watch unavailable, polling only: ${error?.message ?? error}`)
  }
  // Catches pid deaths and ended-session expiry, which produce no fs events.
  interval = setInterval(publish, RESCAN_INTERVAL_MS)
  publish()
}

export function deactivate() {
  watcher?.close()
  clearInterval(interval)
  clearTimeout(debounce)
  watcher = interval = debounce = null
}
