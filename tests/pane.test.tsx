import { test, expect } from 'claude-code/testing'
import { linkColumnsFor, rowsFor, toneOf, age, footerFor } from '../hooks/pane'
import type { Card, ContextState, Ref } from '../types'

const ref = (id: string, kind: Ref['kind'], href: string, extra: Partial<Ref> = {}): Ref => ({
  id, kind, href, firstSeen: 1, lastSeen: 1, mentions: 1, sources: ['prompt'], snippet: `about ${id}`,
  score: 0.5, why: '', pinned: false, untracked: false, notes: [], ...extra,
})

const jiraCard = (n: number): Card => ({
  kind: 'jira', summary: 'Retry failed file uploads', status: 'In Progress', assignee: 'alex', blockers: [],
  subtasks: Array.from({ length: n }, (_, i) => ({ key: `PROJ-${1235 + i}`, status: i === 0 ? 'Done' : i === 1 ? 'Blocked' : 'To Do', title: `step ${i}` })),
})

const LONG_BRANCH = 'PROJ-1234-add-retry-to-file-uploads'

const withLongBranch = (s: ContextState): ContextState => {
  const { 'PROJ-1234-upload-retry': _branch, ...refs } = s.refs
  return { ...s, refs: { ...refs, [LONG_BRANCH]: ref(LONG_BRANCH, 'branch', `https://github.com/acme/app/tree/${LONG_BRANCH}`, { score: 1 }) } }
}

const fixture = (subtasks: number, alsoCount: number, info = 'Retry failed file uploads'): ContextState => {
  const refs: Record<string, Ref> = {
    'acme/app#412': ref('acme/app#412', 'github-pr', 'https://github.com/acme/app/pull/412', {
      score: 0.9, card: { kind: 'github-pr', number: 412, title: info, state: 'open', checks: 'pass', reviewDecision: '' },
    }),
    'https://example.slack.com/archives/C1/p1': ref('https://example.slack.com/archives/C1/p1', 'slack', 'https://example.slack.com/archives/C1/p1', {
      score: 0.9, card: { kind: 'slack', channel: 'team-dev', replyCount: 9, participants: [], latest: { author: 'alex', age: '1m', text: 'retry three times' }, newSince: 2 },
    }),
    'PROJ-1234': ref('PROJ-1234', 'jira', 'https://example.atlassian.net/browse/PROJ-1234', { score: 0.95, card: jiraCard(subtasks) }),
    'PROJ-1234-upload-retry': ref('PROJ-1234-ret…', 'branch', 'https://github.com/acme/app/tree/PROJ-1234-upload-retry', { score: 1 }),
  }
  for (let i = 0; i < alsoCount; i++) {
    const id = `PROJ-${1100 + i}`
    refs[id] = ref(id, 'jira', `https://example.atlassian.net/browse/${id}`, { score: 0.8 - i * 0.05, why: `why ${i}` })
  }
  return { refs, activity: 'active', lastPromptAt: 0 }
}

test('rowsFor orders PR, Slack, Jira with sub-tasks, branch, then also refs', () => {
  const rows = rowsFor(fixture(7, 8))
  expect(rows.map(r => r.key)).toEqual([
    'acme/app#412',
    'https://example.slack.com/archives/C1/p1',
    'PROJ-1234',
    'PROJ-1234/PROJ-1235', 'PROJ-1234/PROJ-1236', 'PROJ-1234/PROJ-1237', 'PROJ-1234/PROJ-1238', 'PROJ-1234/PROJ-1239',
    'PROJ-1234/+2',
    'PROJ-1234-ret…',
    'PROJ-1100', 'PROJ-1101', 'PROJ-1102', 'PROJ-1103', 'PROJ-1104', 'PROJ-1105',
  ])
  expect(rows.map(r => r.group)).toEqual([...Array(10).fill('primary'), ...Array(6).fill('also')])

  const [pr, slack, jira, sub1, sub2, sub3] = rows
  expect(pr).toMatchObject({ link: 'PR #412', status: 'open ✓', tone: 'ok', href: 'https://github.com/acme/app/pull/412' })
  expect(slack).toMatchObject({ link: '#team-dev', info: 'alex: retry three times', status: '2 new' })
  expect(jira).toMatchObject({ link: 'PROJ-1234', info: 'Retry failed file uploads', status: 'In Prog', tone: 'warn' })
  expect(sub1).toMatchObject({ icon: '', link: '↳ PROJ-1235', info: 'step 0', status: '✓ Done', tone: 'ok', href: 'https://example.atlassian.net/browse/PROJ-1235' })
  expect(sub2).toMatchObject({ status: '⛔ Blocked', tone: 'bad' })
  expect(sub3).toMatchObject({ status: '○ To Do', tone: 'plain' })
  expect(rows[8]).toMatchObject({ icon: '', link: '↳ +2', href: 'https://example.atlassian.net/browse/PROJ-1234' })
  expect(rows[9]).toMatchObject({ link: 'PROJ-1234-ret…', info: '', status: '' })
  expect(rows[10]).toMatchObject({ link: 'PROJ-1100', info: 'why 0' })
})

test('status words carry tone', () => {
  expect(toneOf('Done')).toEqual('ok')
  expect(toneOf('Blocked')).toEqual('bad')
  expect(toneOf('In Progress')).toEqual('warn')
  expect(toneOf('merged')).toEqual('merged')
  expect(toneOf('Open')).toEqual('plain')

  const prWith = (state: 'open' | 'merged' | 'closed', checks: 'pass' | 'fail' | 'pending' | 'none') => {
    const s = fixture(0, 0)
    const pr = s.refs['acme/app#412']!
    s.refs[pr.id] = { ...pr, card: { kind: 'github-pr', number: 412, title: 't', state, checks, reviewDecision: '' } }
    return rowsFor(s)[0]
  }
  expect(prWith('open', 'fail')).toMatchObject({ status: 'open ✗', tone: 'bad' })
  expect(prWith('open', 'pending')).toMatchObject({ status: 'open …', tone: 'warn' })
  expect(prWith('open', 'none')).toMatchObject({ status: 'open', tone: 'plain' })
  expect(prWith('merged', 'fail')).toMatchObject({ status: 'merged ✗', tone: 'merged' })
  expect(prWith('closed', 'pending')).toMatchObject({ status: 'closed …', tone: 'plain' })
  expect(prWith('merged', 'none')).toMatchObject({ status: 'merged', tone: 'merged' })
  expect(prWith('closed', 'none')).toMatchObject({ status: 'closed', tone: 'plain' })
})

test('a merged PR with passing checks keeps its status within 12 characters', () => {
  const s = fixture(0, 0)
  const pr = s.refs['acme/app#412']!
  s.refs[pr.id] = { ...pr, card: { kind: 'github-pr', number: 412, title: 't', state: 'merged', checks: 'pass', reviewDecision: '' } }
  const row = rowsFor(s)[0]
  expect(row).toMatchObject({ status: 'merged ✓', tone: 'merged' })
  expect([...row!.status].length <= 9).toEqual(true)
})

test('a link label over 28 characters is cut to 27 plus an ellipsis', () => {
  const s = withLongBranch(fixture(0, 0))
  const branch = rowsFor(s).find(r => r.key === LONG_BRANCH)
  expect(branch?.link).toEqual('PROJ-1234-add-retry-to-file…')
  expect([...branch!.link].length).toEqual(28)
  expect(rowsFor(s).find(r => r.key === 'PROJ-1234')?.link).toEqual('PROJ-1234')
})

test('a stale ref keeps its card, low score dims, quiet slack shows message count', () => {
  const s = fixture(0, 1)
  const jira = s.refs['PROJ-1234']!
  s.refs[jira.id] = { ...jira, error: 'timeout' }
  const slack = s.refs['https://example.slack.com/archives/C1/p1']!
  s.refs[slack.id] = { ...slack, card: { kind: 'slack', channel: 'team-dev', replyCount: 9, participants: [], latest: { author: 'a', age: '1m', text: 't' }, newSince: 0 } }
  const low = s.refs['PROJ-1100']!
  s.refs[low.id] = { ...low, score: 0.1 }
  const rows = rowsFor(s)
  expect(rows.find(r => r.key === 'PROJ-1234')).toMatchObject({ status: 'stale', tone: 'muted', info: 'Retry failed file uploads' })
  expect(rows.find(r => r.key === slack.id)).toMatchObject({ status: '9 msgs' })
  expect(rows.find(r => r.key === 'PROJ-1100')?.dim).toEqual(true)
  expect(rows.find(r => r.key === 'PROJ-1234')?.dim).toEqual(false)
})

test('age and footer', () => {
  expect(age(5_000)).toEqual('5s ago')
  expect(age(60_000)).toEqual('1m ago')
  expect(age(3 * 3_600_000)).toEqual('3h ago')
  expect(age(2 * 86_400_000)).toEqual('2d ago')

  const now = 10_000_000
  const s = fixture(0, 0)
  const pr = s.refs['acme/app#412']!
  s.refs[pr.id] = { ...pr, fetchedAt: now - 60_000 }
  s.lastCuratedAt = now - 180_000
  expect(footerFor(s, now)).toEqual('updated 1m ago · curated 3m ago')
  expect(footerFor({ ...s, activity: 'idle' }, now)).toEqual('updated 1m ago · curated 3m ago · paused')

  const jira = s.refs['PROJ-1234']!
  s.refs[jira.id] = { ...jira, error: 'not connected: Atlassian, run /mcp' }
  expect(footerFor(s, now)).toEqual('not connected: Atlassian, run /mcp')
})

const mountProps = {
  title: 'Quick refs', isFocused: false, bodyColumns: 44, placement: 'dock',
  scroll: { offset: 0, bodyRows: 40 }, view: {},
} as const

test('every row is a Link, labels fit 28 columns, info truncates, on terminal and desktop', async ($, on) => {
  const s = withLongBranch(fixture(3, 2, 'x'.repeat(120)))
  on('state.get', () => ({ value: { value: { shape: 'context-1', value: s }, version: 1 } }))
  const rows = rowsFor(s)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'quick-refs', surface, component: 'Pane', requestId: 'refs',
      props: mountProps, viewport: { columns: 44, rows: 40 },
    })
    expect(await ui.find({ type: 'Link', text: /PROJ-1234/ })).toBeDefined()
    const links = await ui.findAll({ type: 'Link' })
    expect(links.map(l => l.props.href)).toEqual(rows.map(r => r.href))

    const drawn = await ui.drawn()
    expect((drawn as { children: unknown[] }).children).toHaveLength(4)
    expect(await ui.find({ type: 'Text', text: 'Session Focus' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'Also Referenced' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^updated / })).toBeDefined()

    const long = await ui.find({ type: 'Text', text: 'x'.repeat(120) })
    expect(long?.props.wrap).toEqual('truncate-end')
    expect(await ui.find({ type: 'Text', text: 'In Prog' })).toBeDefined()
    for (const link of links) expect([...String(link.props.label)].length <= 28).toEqual(true)
    expect(links.map(l => l.props.label)).toContain('PROJ-1234-add-retry-to-file…')
    expect(await ui.find({ type: 'Svg' })).toEqual(surface === 'desktop' ? expect.anything() : undefined)
    await ui.unmount()
  }
})

test('seedDemo fills the pane with the reference layout rows', { options: { seedDemo: true } }, async ($, on) => {
  on('command.register', () => ({ value: { command: 'quick-refs' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__quick-refs__note' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ value: 'abc123\n' }))
  on('session.messages', () => ({ value: [] }))
  await $.session.start({ cwd: '/', surface: 'desktop', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'quick-refs', surface: 'terminal', component: 'Pane', requestId: 'refs', props: mountProps })
  const links = await ui.findAll({ type: 'Link' })
  expect(links.map(l => l.props.label)).toEqual([
    'PR #412', '#team-dev', 'PROJ-1234', 'PROJ-1235', 'PROJ-1236', 'PROJ-1237', 'PROJ-1234-upload-retry',
    'PROJ-1201', 'PR #398', '#team-oncall',
  ])
  expect(await ui.find({ type: 'Text', text: 'updated 1m ago · curated 3m ago' })).toBeDefined()
  await ui.unmount()
})

test('the newest open action note leads the info column, ahead of the card summary', async ($, on) => {
  const s = fixture(0, 0)
  const jira = s.refs['PROJ-1234']!
  s.refs[jira.id] = {
    ...jira,
    notes: [
      { text: 'old action', kind: 'action', done: false, at: 1 },
      { text: 'retry three times', kind: 'action', done: false, at: 2 },
      { text: 'done already', kind: 'action', done: true, at: 3 },
      { text: 'a fact', kind: 'fact', done: false, at: 4 },
    ],
  }
  expect(rowsFor(s).find(r => r.key === 'PROJ-1234')?.info).toEqual('□ retry three times')
  expect(rowsFor(fixture(0, 0)).find(r => r.key === 'PROJ-1234')?.info).toEqual('Retry failed file uploads')

  on('state.get', () => ({ value: { value: { shape: 'context-1', value: s }, version: 1 } }))
  const ui = await $.ui.mount({ plugin: 'quick-refs', surface: 'terminal', component: 'Pane', requestId: 'refs', props: mountProps, viewport: { columns: 44, rows: 40 } })
  expect(await ui.find({ type: 'Text', text: '□ retry three times' })).toBeDefined()
  await ui.unmount()
})

test('an error with no card shows error, not stale', () => {
  const s = fixture(0, 0)
  const jira = s.refs['PROJ-1234']!
  s.refs[jira.id] = { ...jira, card: undefined, error: 'channel not found' }
  expect(rowsFor(s).find(r => r.key === 'PROJ-1234')).toMatchObject({ status: 'error', tone: 'bad' })
})

test('the link column fits the longest label, capped at 28', () => {
  const row = (link: string) => ({ key: link, icon: '', href: '', link, info: '', status: '', tone: 'plain' as const, dim: false, group: 'primary' as const })
  expect(linkColumnsFor([row('main'), row('PR #12345'), row('#C0EXAMPLE01')])).toBe(12)
  expect(linkColumnsFor([row('PROJ-1234-add-retry-to-file-uploads')])).toBe(28)
  expect(linkColumnsFor([row('PR #1')])).toBe(5)
})

test('every status word maps to a tone, so every status draws a tag', () => {
  expect(toneOf("Won't Do")).toEqual('muted')
  expect(toneOf('error')).toEqual('bad')
  expect(toneOf('To Do')).toEqual('plain')
})
