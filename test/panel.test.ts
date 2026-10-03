import { afterEach, describe, expect, test } from 'bun:test'
import { type MountedPanel, type PanelHost, mountPanel, panelHtml, sleep } from './harness.ts'

let panel: MountedPanel | null = null

afterEach(async () => {
  await panel?.close()
  panel = null
})

async function show(sessions: unknown[], host: PanelHost | null = { terminals: ['term_A', 'term_B'] }) {
  panel = await mountPanel(panelHtml(sessions), host)
  return panel.document
}

const t0 = Date.now() - 60_000

function session(overrides: Record<string, unknown> = {}) {
  return {
    sessionId: '01a10370-6bf8-7317-8c5c-67f71ac91def',
    terminalHandle: 'term_A',
    title: 'Fix login',
    status: 'working',
    todoPhases: [],
    subagents: [],
    ...overrides,
  }
}

function sub(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    agent: 'scout',
    description: null,
    status: 'completed',
    startedAt: t0,
    endedAt: t0 + 21_000,
    model: null,
    assignment: null,
    activity: null,
    toolCount: 0,
    requests: 0,
    tokens: 0,
    cost: 0,
    contextPct: null,
    completionPct: null,
    recentTools: [],
    ...overrides,
  }
}

const text = (node: { textContent: string | null } | null) => node?.textContent ?? ''
const names = (doc: MountedPanel['document']) => Array.from(doc.querySelectorAll('.sub-name'), (n) => n.textContent)

describe('which sessions are shown', () => {
  test('stays blank until Orca reports the focused worktree', async () => {
    const doc = await show([session()], null)
    expect(text(doc.getElementById('content'))).toBe('')
  })

  test('shows only sessions running in a terminal of the focused worktree', async () => {
    const doc = await show(
      [session({ title: 'Here' }), session({ sessionId: 'b', terminalHandle: 'term_Z', title: 'Elsewhere' })],
      { terminals: ['term_A'] },
    )
    const titles = Array.from(doc.querySelectorAll('.session-title'), (n) => n.textContent)
    expect(titles).toEqual(['Here'])
  })

  test('explains when the worktree has no omp session', async () => {
    const doc = await show([session({ terminalHandle: 'term_Z' })], { terminals: ['term_A'] })
    expect(text(doc.querySelector('.empty'))).toContain('No omp session in this worktree')
  })

  test('reports when Orca refuses the workspace read', async () => {
    const doc = await show([session()], { error: 'capability denied' })
    expect(text(doc.querySelector('.empty'))).toBe('Cannot read workspace: capability denied')
  })

  test('follows focus changes to another worktree without a reload', async () => {
    const host = { terminals: ['term_A'] }
    const doc = await show([session({ title: 'A' }), session({ sessionId: 'b', terminalHandle: 'term_B', title: 'B' })], host)
    expect(Array.from(doc.querySelectorAll('.session-title'), (n) => n.textContent)).toEqual(['A'])

    host.terminals = ['term_B']
    await sleep(1700) // Context poll interval is 1.5 s.

    expect(Array.from(doc.querySelectorAll('.session-title'), (n) => n.textContent)).toEqual(['B'])
  })
})

describe('layout', () => {
  test('todos come first, then a single subagent list for all sessions', async () => {
    const doc = await show([
      session({ subagents: [sub('Alpha')] }),
      session({ sessionId: 'b', terminalHandle: 'term_B', title: 'Other', subagents: [sub('Beta')] }),
    ])
    const content = doc.getElementById('content')!
    const blocks = Array.from(content.children, (n) => (n.tagName === 'H2' ? `h2:${n.textContent}` : n.tagName.toLowerCase()))

    expect(blocks).toEqual(['section', 'h2:Subagents', 'ul'])
    expect(text(content.querySelector('section h2'))).toBe('Todos')
    expect(doc.querySelectorAll('ul .sub')).toHaveLength(2)
  })

  test('sessions are named by title, never by their id', async () => {
    const doc = await show([session({ title: null })])
    expect(text(doc.querySelector('.session-title'))).toBe('Untitled session')
    expect(text(doc.getElementById('content'))).not.toContain('01a10370')
  })

  test('a session without todos says so instead of disappearing', async () => {
    const doc = await show([session()])
    expect(text(doc.querySelector('.session-head'))).toContain('Fix login')
    expect(text(doc.querySelector('.none'))).toBe('No todos.')
    expect(doc.querySelector('.sub')).toBeNull()
  })
})

describe('todos', () => {
  test('each phase shows its tasks with status marks and done count', async () => {
    const doc = await show([
      session({
        todoPhases: [
          {
            name: 'Build',
            tasks: [
              { content: 'plan', status: 'completed' },
              { content: 'drop idea', status: 'abandoned' },
              { content: 'code', status: 'in_progress' },
              { content: 'ship', status: 'pending' },
              { content: 'deploy', status: 'blocked', blocker: 'needs token' },
            ],
          },
        ],
      }),
    ])

    expect(text(doc.querySelector('.phase'))).toBe('Build2/5')
    const tasks = Array.from(doc.querySelectorAll('li.task'), (n) => [n.className, text(n.querySelector('.mark'))])
    expect(tasks).toEqual([
      ['task completed', '✓'],
      ['task abandoned', '✕'],
      ['task in_progress', '◐'],
      ['task pending', '○'],
      ['task blocked', '⊘'],
    ])
    expect(text(doc.querySelector('.task.blocked .blocker'))).toBe('Blocked: needs token')
  })
})

describe('subagents', () => {
  test('running subagents come first, then the most recently started, across sessions', async () => {
    const doc = await show([
      session({ subagents: [sub('OldDone', { startedAt: t0 }), sub('Running1', { status: 'running', startedAt: t0, endedAt: null })] }),
      session({
        sessionId: 'b',
        terminalHandle: 'term_B',
        subagents: [sub('NewDone', { startedAt: t0 + 5000 }), sub('Running2', { status: 'running', startedAt: t0 + 1000, endedAt: null })],
      }),
    ])

    expect(names(doc)).toEqual(['Running2', 'Running1', 'NewDone', 'OldDone'])
    expect(text(doc.querySelector('#content > h2'))).toBe('Subagents · 2 running')
  })

  test('the owning session is named only when several sessions share the list', async () => {
    const one = await show([session({ subagents: [sub('Solo', { model: 'anthropic/opus' })] })])
    expect(text(one.querySelector('.sub-meta'))).toBe('scout · completed · anthropic/opus')
    await panel!.close()

    const two = await show([
      session({ subagents: [sub('Mine')] }),
      session({ sessionId: 'b', terminalHandle: 'term_B', title: null, subagents: [sub('Theirs', { startedAt: t0 - 1 })] }),
    ])
    expect(Array.from(two.querySelectorAll('.sub-meta'), (n) => n.textContent)).toEqual([
      'Fix login · scout · completed',
      'Untitled session · scout · completed',
    ])
  })

  test('a running subagent shows its activity, estimate, stats and recent tools', async () => {
    const doc = await show([
      session({
        subagents: [
          sub('Scout', {
            status: 'running',
            endedAt: null,
            description: 'Find the bug',
            assignment: '# Target\nfull assignment',
            activity: 'Reading README',
            completionPct: 40,
            toolCount: 1,
            requests: 5,
            tokens: 21500,
            cost: 0.204,
            contextPct: 3,
            recentTools: [
              { tool: 'read', text: 'Reading README', isError: false },
              { tool: 'grep', text: null, isError: true },
            ],
          }),
        ],
      }),
    ])

    expect(doc.querySelector('.sub .dot')!.className).toBe('dot running')
    expect(text(doc.querySelector('.sub-desc'))).toBe('Find the bug')
    expect(doc.querySelector('.sub-name')!.getAttribute('title')).toBe('# Target\nfull assignment')
    expect(text(doc.querySelector('.sub-activity'))).toBe('~40%Reading README')
    expect(text(doc.querySelector('.sub-stats'))).toBe('1 tool · 5 req · 22k tok · $0.20 · ctx 3%')
    expect(Array.from(doc.querySelectorAll('.sub-tools'), (n) => [n.className, n.textContent])).toEqual([
      ['sub-tools', 'read Reading README'],
      ['sub-tools error', '✕ grep'],
    ])
  })

  test('a finished subagent shows no activity and no stats it never had', async () => {
    const doc = await show([session({ subagents: [sub('Done', { activity: 'stale', completionPct: 90 })] })])
    expect(doc.querySelector('.sub-activity')).toBeNull()
    expect(doc.querySelector('.sub-stats')).toBeNull()
  })

  test('elapsed time counts up for running subagents and is frozen for finished ones', async () => {
    const startedAt = Date.now() - 5_000
    const doc = await show([
      session({
        subagents: [sub('Live', { status: 'running', startedAt, endedAt: null }), sub('Done', { startedAt: t0, endedAt: t0 + 3_725_000 })],
      }),
    ])
    const times = () => Array.from(doc.querySelectorAll('.sub-time'), (n) => n.textContent)
    expect(times()).toEqual(['5s', '1h 2m'])

    await sleep(2100)

    expect(times()).toEqual(['7s', '1h 2m'])
  })
})
