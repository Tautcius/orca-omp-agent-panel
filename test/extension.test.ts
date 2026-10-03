import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import * as fs from 'node:fs'
import {
  type Dirs,
  FakeOmp,
  type OmpOptions,
  WRITE_SETTLE_MS,
  deadPid,
  lifecycle,
  hudState,
  panelData,
  panelPath,
  progress,
  readState,
  removeTempDirs,
  renderPanel,
  sleep,
  stateFile,
  todoEdit,
  todoResult,
  useTempDirs,
  writeState,
} from './harness.ts'

let dirs: Dirs
let open: FakeOmp[]

function omp(options: OmpOptions): FakeOmp {
  const session = new FakeOmp(options)
  open.push(session)
  return session
}

beforeEach(() => {
  dirs = useTempDirs()
  open = []
})

afterEach(() => {
  for (const session of open) session.shutdown()
  removeTempDirs(dirs)
})

const PHASES = [
  { name: 'Build', tasks: [{ content: 'write code', status: 'in_progress' }, { content: 'ship', status: 'pending' }] },
]

describe('session state file', () => {
  test('a new session is published as idle with its Orca terminal and title', async () => {
    omp({ sessionId: 's1', terminal: 'term_X', title: 'Fix login' }).start()
    await sleep(WRITE_SETTLE_MS)

    const state = readState(dirs, 's1')
    expect(state).toMatchObject({
      version: 1,
      sessionId: 's1',
      pid: process.pid,
      terminalHandle: 'term_X',
      title: 'Fix login',
      status: 'idle',
      todoPhases: [],
      subagents: [],
    })
  })

  test('run status follows the agent: working during a turn, idle only after a terminal agent_end', async () => {
    const session = omp({ sessionId: 's1' }).start()

    session.emit('agent_start')
    await sleep(WRITE_SETTLE_MS)
    expect(readState(dirs, 's1').status).toBe('working')

    session.emit('agent_end', { willContinue: true })
    await sleep(WRITE_SETTLE_MS)
    expect(readState(dirs, 's1').status).toBe('working')

    session.emit('agent_end', { willContinue: false })
    await sleep(WRITE_SETTLE_MS)
    expect(readState(dirs, 's1').status).toBe('idle')
  })

  test('subagent sessions never publish a state file of their own', async () => {
    omp({ sessionId: 'main' }).start()
    omp({ sessionId: 'child', kind: 'sub' }).start()
    await sleep(WRITE_SETTLE_MS)

    expect(fs.existsSync(stateFile(dirs, 'main'))).toBe(true)
    expect(fs.existsSync(stateFile(dirs, 'child'))).toBe(false)
  })

  test('shutdown marks the session ended and aborts subagents still running', async () => {
    const session = omp({ sessionId: 's1' }).start()
    session.publish('task:subagent:lifecycle', lifecycle('Busy', 'started'))
    session.publish('task:subagent:lifecycle', lifecycle('Done', 'started'))
    session.publish('task:subagent:lifecycle', lifecycle('Done', 'completed'))

    session.shutdown()

    const state = readState(dirs, 's1')
    expect(state.status).toBe('ended')
    const byId = Object.fromEntries(state.subagents.map((s: any) => [s.id, s.status]))
    expect(byId).toEqual({ Busy: 'aborted', Done: 'completed' })
  })

  test('/clear (new session id) ends the old session file and starts a fresh one', async () => {
    const session = omp({ sessionId: 'old', branch: [todoResult(PHASES)] }).start()
    session.publish('task:subagent:lifecycle', lifecycle('Scout', 'started'))
    await sleep(WRITE_SETTLE_MS)

    session.sessionId = 'new'
    session.branch = []
    session.emit('session_switch')
    await sleep(WRITE_SETTLE_MS)

    const old = readState(dirs, 'old')
    expect(old.status).toBe('ended')
    expect(old.subagents[0].status).toBe('aborted')
    expect(readState(dirs, 'new')).toMatchObject({ status: 'idle', todoPhases: [], subagents: [] })
  })
})

describe('todos', () => {
  test('a successful todo tool result replaces the published phases', async () => {
    const session = omp({ sessionId: 's1' }).start()
    session.emit('tool_result', { toolName: 'todo', isError: false, details: { op: 'update', phases: PHASES } })
    await sleep(WRITE_SETTLE_MS)

    expect(readState(dirs, 's1').todoPhases).toEqual(PHASES)
  })

  test('failed and view-only todo results do not change the phases', async () => {
    const session = omp({ sessionId: 's1' }).start()
    session.emit('tool_result', { toolName: 'todo', isError: false, details: { op: 'update', phases: PHASES } })
    session.emit('tool_result', { toolName: 'todo', isError: true, details: { op: 'update', phases: [] } })
    session.emit('tool_result', { toolName: 'todo', isError: false, details: { op: 'view', phases: [] } })
    await sleep(WRITE_SETTLE_MS)

    expect(readState(dirs, 's1').todoPhases).toEqual(PHASES)
  })

  test('unknown task statuses are shown as pending and blockers are kept', async () => {
    const session = omp({ sessionId: 's1' }).start()
    const phases = [
      {
        name: 'P',
        tasks: [
          { content: 'odd', status: 'weird' },
          { content: 'stuck', status: 'blocked', blocker: 'waiting for user' },
          { status: 'pending' },
        ],
      },
    ]
    session.emit('tool_result', { toolName: 'todo', isError: false, details: { op: 'update', phases } })
    await sleep(WRITE_SETTLE_MS)

    expect(readState(dirs, 's1').todoPhases).toEqual([
      {
        name: 'P',
        tasks: [
          { content: 'odd', status: 'pending' },
          { content: 'stuck', status: 'blocked', blocker: 'waiting for user' },
        ],
      },
    ])
  })

  test('a resumed session restores the latest todo snapshot from its history', async () => {
    const first = [{ name: 'Old', tasks: [{ content: 'a', status: 'pending' }] }]
    const edited = [{ name: 'Edited', tasks: [{ content: 'b', status: 'completed' }] }]
    omp({
      sessionId: 's1',
      branch: [todoResult(first), todoEdit(edited), todoResult([], { op: 'view' }), todoResult([], { isError: true })],
    }).start()
    await sleep(WRITE_SETTLE_MS)

    expect(readState(dirs, 's1').todoPhases).toEqual(edited)
  })

  test('a /todo edit made without any agent event still reaches the panel', async () => {
    const session = omp({ sessionId: 's1' }).start()
    await sleep(WRITE_SETTLE_MS)

    session.append(todoEdit(PHASES))
    // Leaf poll runs every second.
    await sleep(1000 + WRITE_SETTLE_MS)

    expect(readState(dirs, 's1').todoPhases).toEqual(PHASES)
  })

  test('branch navigation shows the todo snapshot of the selected branch', async () => {
    const other = [{ name: 'Other branch', tasks: [] }]
    const session = omp({ sessionId: 's1', branch: [todoResult(PHASES)] }).start()
    await sleep(WRITE_SETTLE_MS)

    session.branch = [todoResult(other)]
    session.emit('session_tree')
    await sleep(WRITE_SETTLE_MS)

    expect(readState(dirs, 's1').todoPhases).toEqual(other)
  })

  test('a finished todo list leaves the panel when omp dismisses it from its todo HUD', async () => {
    const done = [{ name: 'Demo', tasks: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'abandoned' }] }]
    const snapshot = todoResult(done)
    const session = omp({ sessionId: 's1', branch: [snapshot] }).start()
    await sleep(WRITE_SETTLE_MS)
    expect(readState(dirs, 's1').todoPhases).toEqual(done)

    // omp writes this `tasks.todoClearDelay` seconds after the last task finished.
    session.append(hudState(snapshot, 'dismissed'))
    await sleep(1000 + WRITE_SETTLE_MS)

    expect(readState(dirs, 's1').todoPhases).toEqual([])
  })

  test('a dismissed list stays hidden after resume, unless the user reveals it again', async () => {
    const snapshot = todoResult(PHASES)
    const session = omp({ sessionId: 's1', branch: [snapshot, hudState(snapshot, 'dismissed')] }).start()
    await sleep(WRITE_SETTLE_MS)
    expect(readState(dirs, 's1').todoPhases).toEqual([])

    session.append(hudState(snapshot, 'revealed'))
    await sleep(1000 + WRITE_SETTLE_MS)

    expect(readState(dirs, 's1').todoPhases).toEqual(PHASES)
  })

  test('dismissing an old list does not hide a newer one', async () => {
    const old = todoResult([{ name: 'Old', tasks: [{ content: 'a', status: 'completed' }] }])
    omp({ sessionId: 's1', branch: [old, hudState(old, 'dismissed'), todoResult(PHASES)] }).start()
    await sleep(WRITE_SETTLE_MS)

    expect(readState(dirs, 's1').todoPhases).toEqual(PHASES)
  })
})

describe('subagents', () => {
  test('lifecycle events track a subagent from start to completion', async () => {
    const session = omp({ sessionId: 's1' }).start()
    session.publish('task:subagent:lifecycle', lifecycle('Scout', 'started', { description: 'Find the bug' }))
    await sleep(WRITE_SETTLE_MS)

    const running = readState(dirs, 's1').subagents[0]
    expect(running).toMatchObject({ id: 'Scout', agent: 'scout', description: 'Find the bug', status: 'running', endedAt: null })

    session.publish('task:subagent:lifecycle', lifecycle('Scout', 'failed'))
    await sleep(WRITE_SETTLE_MS)

    const failed = readState(dirs, 's1').subagents[0]
    expect(failed.status).toBe('failed')
    expect(failed.endedAt).toBeGreaterThanOrEqual(running.startedAt)
  })

  test('malformed lifecycle events are ignored', async () => {
    const session = omp({ sessionId: 's1' }).start()
    session.publish('task:subagent:lifecycle', { agent: 'scout', status: 'started' })
    session.publish('task:subagent:lifecycle', lifecycle('X', 'paused'))
    session.publish('task:subagent:lifecycle', null)
    await sleep(WRITE_SETTLE_MS)

    expect(readState(dirs, 's1').subagents).toEqual([])
  })

  test('a progress tick registers a running subagent the panel has not seen yet', async () => {
    const session = omp({ sessionId: 's1' }).start()
    session.publish('task:subagent:progress', progress('Late', { status: 'completed' }))
    session.publish('task:subagent:progress', progress('Live', { description: 'Probe' }))
    await sleep(WRITE_SETTLE_MS)

    const subs = readState(dirs, 's1').subagents
    expect(subs.map((s: any) => s.id)).toEqual(['Live'])
    expect(subs[0]).toMatchObject({ status: 'running', description: 'Probe' })
  })

  test('progress details become model, stats, activity and recent tools', async () => {
    const session = omp({ sessionId: 's1' }).start()
    session.publish(
      'task:subagent:progress',
      progress(
        'Scout',
        {
          resolvedModel: 'anthropic/opus',
          modelOverride: 'ignored/model',
          lastIntent: 'Reading   the\nREADME',
          currentToolIntent: 'ignored',
          toolCount: 7,
          requests: 3,
          tokens: 21000,
          cost: 0.2,
          contextTokens: 3300,
          contextWindow: 200000,
          completionPercent: 140,
          recentTools: [
            { tool: 'read', intent: 'Reading README' },
            { tool: 'grep', args: 'pattern=foo', isError: true },
            { tool: 'glob', args: '*.ts' },
            { tool: 'bash', args: 'ls' },
          ],
        },
        { assignment: `# Target\n\n${'x'.repeat(700)}` },
      ),
    )
    await sleep(WRITE_SETTLE_MS)

    const sub = readState(dirs, 's1').subagents[0]
    expect(sub).toMatchObject({
      model: 'anthropic/opus',
      activity: 'Reading the README',
      toolCount: 7,
      requests: 3,
      tokens: 21000,
      cost: 0.2,
      contextPct: 2,
      completionPct: 100,
      recentTools: [
        { tool: 'read', text: 'Reading README', isError: false },
        { tool: 'grep', text: 'pattern=foo', isError: true },
        { tool: 'glob', text: '*.ts', isError: false },
      ],
    })
    expect(sub.assignment.startsWith('# Target x')).toBe(true)
    expect(sub.assignment).toHaveLength(600)
    expect(sub.assignment.endsWith('…')).toBe(true)
  })

  test('without an intent, activity falls back to the tool intent, then the tool call', async () => {
    const session = omp({ sessionId: 's1' }).start()
    session.publish('task:subagent:progress', progress('A', { currentToolIntent: 'Searching code', currentTool: 'grep' }))
    session.publish('task:subagent:progress', progress('B', { currentTool: 'read', currentToolArgs: 'src/a.ts' }))
    session.publish('task:subagent:progress', progress('C', { modelOverride: 'openai/gpt' }))
    await sleep(WRITE_SETTLE_MS)

    const subs = readState(dirs, 's1').subagents
    expect(subs.map((s: any) => [s.id, s.activity, s.model])).toEqual([
      ['A', 'Searching code', null],
      ['B', 'read src/a.ts', null],
      ['C', null, 'openai/gpt'],
    ])
  })

  test('a finished subagent shows no current activity', async () => {
    const session = omp({ sessionId: 's1' }).start()
    session.publish('task:subagent:lifecycle', lifecycle('Scout', 'started'))
    session.publish('task:subagent:progress', progress('Scout', { lastIntent: 'Working' }))
    session.publish('task:subagent:lifecycle', lifecycle('Scout', 'completed'))
    session.publish('task:subagent:progress', progress('Scout', { status: 'completed', lastIntent: 'Late tick' }))
    await sleep(WRITE_SETTLE_MS)

    expect(readState(dirs, 's1').subagents[0]).toMatchObject({ status: 'completed', activity: null })
  })

  test('progress-only ticks are batched instead of written at once', async () => {
    const session = omp({ sessionId: 's1' }).start()
    session.publish('task:subagent:lifecycle', lifecycle('Scout', 'started'))
    await sleep(WRITE_SETTLE_MS)

    session.publish('task:subagent:progress', progress('Scout', { lastIntent: 'Tick', toolCount: 1 }))
    await sleep(WRITE_SETTLE_MS)
    expect(readState(dirs, 's1').subagents[0].toolCount).toBe(0)

    // A structural change flushes the pending progress along with it.
    session.publish('task:subagent:lifecycle', lifecycle('Other', 'started'))
    await sleep(WRITE_SETTLE_MS)
    expect(readState(dirs, 's1').subagents[0]).toMatchObject({ toolCount: 1, activity: 'Tick' })
  })

  test('subagents spawned by subagents appear in the main session', async () => {
    const main = omp({ sessionId: 'main' }).start()
    const child = omp({ sessionId: 'child', kind: 'sub' }).start()
    child.publish('task:subagent:lifecycle', lifecycle('Grandchild', 'started'))
    await sleep(WRITE_SETTLE_MS)

    expect(readState(dirs, 'main').subagents.map((s: any) => s.id)).toEqual(['Grandchild'])
    main.shutdown()
  })
})

describe('panel.html', () => {
  test('a restart or /clear in the same terminal shows only the live session', () => {
    const now = Date.now()
    // Ended sessions with newer ids than the live one: the live one is resumed.
    writeState(dirs, { sessionId: '01b', terminalHandle: 'term_A', status: 'ended', updatedAt: now - 1000 })
    writeState(dirs, { sessionId: '01c', terminalHandle: 'term_A', status: 'ended', updatedAt: now - 500 })
    writeState(dirs, { sessionId: '01a', terminalHandle: 'term_A', status: 'working', updatedAt: now - 2000, title: 'Live' })

    renderPanel()

    expect(panelData(dirs).sessions.map((s) => s.sessionId)).toEqual(['01a'])
  })

  test('a terminal whose omp exited shows its most recently written session', () => {
    const now = Date.now()
    writeState(dirs, { sessionId: '01b', terminalHandle: 'term_A', status: 'ended', updatedAt: now - 1000 })
    writeState(dirs, { sessionId: '01a', terminalHandle: 'term_A', status: 'ended', updatedAt: now - 100 })
    writeState(dirs, { sessionId: '01c', terminalHandle: 'term_B', status: 'idle', updatedAt: now })

    renderPanel()

    const shown = panelData(dirs).sessions.map((s) => [s.terminalHandle, s.sessionId])
    expect(shown).toEqual([
      ['term_B', '01c'],
      ['term_A', '01a'],
    ])
  })

  test('a crashed omp (dead pid) is shown as ended', () => {
    writeState(dirs, { sessionId: 's1', terminalHandle: 'term_A', status: 'working', pid: deadPid() })

    renderPanel()

    expect(panelData(dirs).sessions[0].status).toBe('ended')
  })

  test('ended sessions disappear after 10 minutes and their files after 24 hours', () => {
    const now = Date.now()
    writeState(dirs, { sessionId: 'recent', terminalHandle: 'term_A', status: 'ended', updatedAt: now - 9 * 60_000 })
    writeState(dirs, { sessionId: 'old', terminalHandle: 'term_B', status: 'ended', updatedAt: now - 11 * 60_000 })
    writeState(dirs, { sessionId: 'stale', terminalHandle: 'term_C', status: 'ended', updatedAt: now - 25 * 3600_000 })

    renderPanel()

    expect(panelData(dirs).sessions.map((s) => s.sessionId)).toEqual(['recent'])
    expect(fs.existsSync(stateFile(dirs, 'old'))).toBe(true)
    expect(fs.existsSync(stateFile(dirs, 'stale'))).toBe(false)
  })

  test('sessions not started from an Orca terminal and foreign files are skipped', () => {
    writeState(dirs, { sessionId: 'plain', terminalHandle: null })
    writeState(dirs, { sessionId: 'v2', terminalHandle: 'term_A', version: 2 })
    fs.writeFileSync(`${dirs.state}/broken.json`, '{')

    renderPanel()

    expect(panelData(dirs).sessions).toEqual([])
  })

  test('the panel carries only what it draws, with markup in data neutralised', () => {
    writeState(dirs, { sessionId: 's1', terminalHandle: 'term_A', title: '</script><b>x</b>\u2028' })

    renderPanel()

    const html = fs.readFileSync(panelPath(dirs), 'utf8')
    expect(html).not.toContain('</script><b>')
    const [session] = panelData(dirs).sessions
    expect(session.title).toBe('</script><b>x</b>\u2028')
    expect(Object.keys(session).sort()).toEqual(['sessionId', 'status', 'subagents', 'terminalHandle', 'title', 'todoPhases'])
  })

  test('an unchanged render leaves panel.html untouched so Orca does not reload it', async () => {
    writeState(dirs, { sessionId: 's1', terminalHandle: 'term_A' })
    renderPanel()
    const before = fs.statSync(panelPath(dirs))
    await sleep(20)

    renderPanel()

    const after = fs.statSync(panelPath(dirs))
    expect(after.ino).toBe(before.ino)
    expect(after.mtimeMs).toBe(before.mtimeMs)
  })

  test('live changes reach panel.html without a manual render', async () => {
    const session = omp({ sessionId: 's1', terminal: 'term_A' }).start()
    session.emit('tool_result', { toolName: 'todo', isError: false, details: { op: 'update', phases: PHASES } })
    // Write debounce plus the 1 s render throttle.
    await sleep(1000 + WRITE_SETTLE_MS * 2)

    const shown = panelData(dirs).sessions.find((s) => s.sessionId === 's1')
    expect(shown.todoPhases).toEqual(PHASES)
  })
})
