import { test, expect, mock } from 'claude-code/testing'
import { activityFor } from '../hooks/pollers'
import type { Card, ContextState, Ref } from '../types'

type Wrapped = { shape: string; value: ContextState }

const NOW = 1_800_000_000_000
const ATL = '00000000-0000-0000-0000-000000000001'
const SLK = '00000000-0000-0000-0000-000000000002'
const TOOLS = [
  { name: `mcp__${ATL}__getJiraIssue`, description: '', mcp: true },
  { name: `mcp__${SLK}__slack_read_thread`, description: '', mcp: true },
]
const THREAD_A = 'https://example.slack.com/archives/C0AB12CD/p1731150000123456'
const THREAD_B = 'https://example.slack.com/archives/C0XY99/p1731150000000001'

const memoryState = (on: any, initial: ContextState) => {
  let held: Wrapped = { shape: 'context-1', value: initial }
  let version = 0
  const refWrites: Record<string, number> = {}
  on('state.get', () => ({ value: { value: held, version } }))
  on('state.set', (_: unknown, e: { value: Wrapped }) => {
    for (const [id, r] of Object.entries(e.value.value.refs)) {
      if (JSON.stringify(held.value.refs[id]) !== JSON.stringify(r)) refWrites[id] = (refWrites[id] ?? 0) + 1
    }
    held = e.value
    version += 1
    return { value: { isSet: true, version } }
  })
  const put = (change: (s: ContextState) => ContextState) => {
    held = { ...held, value: change(held.value) }
    version += 1
  }
  return { get: () => held.value, put, writes: () => version, writesOf: (id: string) => refWrites[id] ?? 0 }
}

const ref = (id: string, kind: Ref['kind'], href: string, extra: Partial<Ref> = {}): Ref => ({
  id, kind, href, firstSeen: 1, lastSeen: 1, mentions: 1, sources: ['prompt'], snippet: '', score: 0.5, why: '',
  pinned: false, untracked: false, notes: [], ...extra,
})

const ok = (value: unknown) => ({ value: { isError: false, content: [{ type: 'text', text: JSON.stringify(value) }] } })
const failed = (text: string) => ({ value: { isError: true, content: [{ type: 'text', text }] } })

const boot = async ($: any, on: any, refs: Ref[], opts: { tools?: () => unknown[]; lastPromptAt?: number } = {}) => {
  const clock = mock.clock(on, { now: NOW })
  const store = memoryState(on, { refs: Object.fromEntries(refs.map(r => [r.id, r])), activity: 'active', lastPromptAt: opts.lastPromptAt ?? NOW })
  on('command.register', () => ({ value: { command: 'context-pane' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__context-pane__note' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('session.messages', () => ({ value: [] }))
  on('tool.list', () => ({ value: opts.tools?.() ?? TOOLS }))
  on('mcp.call', { server: ATL, tool: 'getAccessibleAtlassianResources' }, () => ok({ data: { resources: [{ cloudId: 'cloud-1', url: 'https://example.atlassian.net' }] } }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  return { clock, store }
}

const issue = (updated: string) => ({
  key: 'PROJ-1234',
  fields: {
    summary: 'Fix', status: { name: 'In Progress' }, assignee: { displayName: 'Alex Rivera' }, updated,
    issuelinks: [
      { type: { name: 'Blocks' }, inwardIssue: { key: 'PROJ-1201' } },
      { type: { name: 'Blocks' }, outwardIssue: { key: 'PROJ-1300' } },
      { type: { name: 'Relates' }, inwardIssue: { key: 'PROJ-1400' } },
    ],
    subtasks: [{ key: 'PROJ-1235', fields: { summary: 'add retry test', status: { name: 'Done' } } }],
    comment: { comments: [
      { author: { displayName: 'Ana' }, created: '2026-11-09T10:00:00.000+0000', body: 'first' },
      { author: { displayName: 'Ben' }, created: '2026-11-10T09:00:00.000+0000', body: 'bump to 90s' },
    ] },
  },
})

const issueResult = (updated: string) => ({ issues: { nodes: [issue(updated)] } })

const jiraRef = () => ref('PROJ-1234', 'jira', 'https://example.atlassian.net/browse/PROJ-1234', {
  fingerprint: 'T0', fetchedAt: 1,
  card: { kind: 'jira', summary: 'old', status: 'To Do', assignee: '', blockers: [], subtasks: [] },
})

test('jira polls once per interval with one JQL call and writes only on a changed updated field', async ($, on) => {
  let updated = 'T1'
  const jqls: string[] = []
  let gets = 0
  on('mcp.call', { server: ATL, tool: 'searchJiraIssuesUsingJql' }, (_: unknown, e: { args: Readonly<Record<string, unknown>> }) => {
    jqls.push(String(e.args.jql))
    expect(e.args.cloudId).toBe('cloud-1')
    return ok({ issues: { nodes: [{ key: 'PROJ-1234', fields: { updated } }] } })
  })
  on('mcp.call', { server: ATL, tool: 'getJiraIssue' }, (_: unknown, e: { args: Readonly<Record<string, unknown>> }) => {
    gets++
    expect(e.args.issueIdOrKey).toBe('PROJ-1234')
    return ok(issueResult(updated))
  })
  const { clock, store } = await boot($, on, [jiraRef()])

  expect(gets).toBe(1)
  expect(jqls).toEqual([])
  const started = store.get().refs['PROJ-1234']
  expect(started?.fingerprint).toBe('T1')
  expect(Math.abs((started?.fetchedAt ?? 0) - Date.now())).toBeLessThan(60_000)
  expect(started?.card).toEqual({
    kind: 'jira', summary: 'Fix', status: 'In Progress', assignee: 'Alex Rivera', blockers: ['PROJ-1201'],
    subtasks: [{ key: 'PROJ-1235', status: 'Done', title: 'add retry test' }],
    lastComment: { author: 'Ben', age: '2026-11-10T09:00:00.000+0000', text: 'bump to 90s' },
  })
  expect(store.writesOf('PROJ-1234')).toBe(1)

  await clock.advance(899_999)
  expect(jqls).toEqual([])
  await clock.advance(1)
  expect(jqls).toEqual(['key in (PROJ-1234) AND updated >= "-16m"'])
  expect(gets).toBe(1)
  expect(store.writesOf('PROJ-1234')).toBe(1)

  updated = 'T2'
  await clock.advance(900_000)
  expect(jqls).toEqual(['key in (PROJ-1234) AND updated >= "-16m"', 'key in (PROJ-1234) AND updated >= "-16m"'])
  expect(gets).toBe(2)
  expect(store.writesOf('PROJ-1234')).toBe(2)
  expect(store.get().refs['PROJ-1234']?.fingerprint).toBe('T2')
})

test('slack fingerprint change bumps newSince and leaves other cards untouched', async ($, on) => {
  const bCard: Card = { kind: 'slack', channel: 'C0XY99', replyCount: 0, participants: ['eve'], latest: { author: 'eve', age: '1731150000.000001', text: 'hi' }, newSince: 0 }
  const asked: Array<{ channel_id: string; message_ts: string }> = []
  on('mcp.call', { server: SLK, tool: 'slack_read_thread' }, (_: unknown, e: { args: Readonly<Record<string, unknown>> }) => {
    asked.push({ channel_id: String(e.args.channel_id), message_ts: String(e.args.message_ts) })
    if (e.args.channel_id === 'C0XY99') return ok({ messages: [{ ts: '1731150000.000001', user_name: 'eve', text: 'hi' }] })
    return ok({ messages: [
      { ts: '1731150000.123456', user_name: 'alex', text: 'uploads fail' },
      { ts: '1731150000.200000', user_name: 'eve', text: 'looking' },
      { ts: '1731150000.300000', user_name: 'eve', text: 'found it' },
      { ts: '1731150000.400000', user_name: 'alex', text: 'retry three times' },
    ] })
  })
  const { store } = await boot($, on, [
    ref(THREAD_A, 'slack', THREAD_A, { fingerprint: '1731150000.200000:1', fetchedAt: 5 }),
    ref(THREAD_B, 'slack', THREAD_B, { fingerprint: '1731150000.000001:0', fetchedAt: 5, card: bCard }),
  ])

  expect(asked).toEqual([
    { channel_id: 'C0AB12CD', message_ts: '1731150000.123456' },
    { channel_id: 'C0XY99', message_ts: '1731150000.000001' },
  ])
  const a = store.get().refs[THREAD_A]
  expect(a?.fingerprint).toBe('1731150000.400000:3')
  expect(a?.card).toEqual({
    kind: 'slack', channel: 'C0AB12CD', replyCount: 3, participants: ['alex', 'eve'],
    latest: { author: 'alex', age: '1731150000.400000', text: 'retry three times' }, newSince: 2,
  })
  const b = store.get().refs[THREAD_B]
  expect(b?.card).toEqual(bCard)
  expect(b?.fetchedAt).toBe(5)
})

test('a connector error marks the card stale once and does not rewrite on the next poll', async ($, on) => {
  let calls = 0
  let isBroken = true
  on('mcp.call', { server: SLK, tool: 'slack_read_thread' }, () => {
    calls++
    return isBroken ? failed('channel_not_found') : ok({ messages: [{ ts: '1731150000.123456', user_name: 'alex', text: 'up' }] })
  })
  const card: Card = { kind: 'slack', channel: 'C0AB12CD', replyCount: 0, participants: [], latest: { author: 'alex', age: '', text: 'up' }, newSince: 0 }
  const { clock, store } = await boot($, on, [ref(THREAD_A, 'slack', THREAD_A, { fingerprint: '1731150000.123456:0', card })])

  expect(store.get().refs[THREAD_A]?.error).toBe('channel_not_found')
  expect(store.get().refs[THREAD_A]?.card).toEqual(card)
  const marked = store.writes()
  await clock.advance(180_000)
  expect(calls).toBe(2)
  expect(store.writes()).toBe(marked)

  isBroken = false
  await clock.advance(180_000)
  expect(calls).toBe(3)
  expect(store.writes()).toBe(marked + 1)
  expect(store.get().refs[THREAD_A]?.error).toBeUndefined()
})

test('a connector missing from the tool list marks its refs not connected once, then recovers', async ($, on) => {
  let tools: unknown[] = []
  let gets = 0
  on('mcp.call', { server: ATL, tool: 'searchJiraIssuesUsingJql' }, () => ok({ issues: { nodes: [] } }))
  on('mcp.call', { server: ATL, tool: 'getJiraIssue' }, () => { gets++; return ok(issueResult('T1')) })
  const { clock, store } = await boot($, on, [jiraRef()], { tools: () => tools })

  expect(store.get().refs['PROJ-1234']?.error).toBe('not connected: Atlassian, run /mcp')
  const marked = store.writes()
  await clock.advance(900_000)
  expect(store.writes()).toBe(marked)
  expect(gets).toBe(0)

  tools = TOOLS
  await clock.advance(900_000)
  expect(gets).toBe(1)
  expect(store.get().refs['PROJ-1234']?.error).toBeUndefined()
  expect(store.get().refs['PROJ-1234']?.fingerprint).toBe('T1')
})

test('a jira ref that failed is fetched directly on the next poll, not through the JQL window', async ($, on) => {
  const gets: string[] = []
  on('mcp.call', { server: ATL, tool: 'searchJiraIssuesUsingJql' }, () => ok({ issues: { nodes: [] } }))
  on('mcp.call', { server: ATL, tool: 'getJiraIssue' }, (_: unknown, e: { args: Readonly<Record<string, unknown>> }) => {
    gets.push(String(e.args.issueIdOrKey))
    return e.args.issueIdOrKey === 'PROJ-2' && gets.length <= 2 ? failed('Issue does not exist') : ok(issueResult('T1'))
  })
  const { clock, store } = await boot($, on, [jiraRef(), ref('PROJ-2', 'jira', 'https://example.atlassian.net/browse/PROJ-2', { fingerprint: 'T0' })])
  expect(store.get().refs['PROJ-2']?.error).toBe('Issue does not exist')

  await clock.advance(900_000)
  expect(gets.filter(k => k === 'PROJ-2').length).toBe(2)
  expect(gets.filter(k => k === 'PROJ-1234').length).toBe(1)
  expect(store.get().refs['PROJ-2']?.error).toBeUndefined()
})

test('activityFor returns quiet after 30 min and idle after 2 h', () => {
  expect(activityFor(NOW, NOW + 29 * 60_000)).toBe('active')
  expect(activityFor(NOW, NOW + 30 * 60_000)).toBe('quiet')
  expect(activityFor(NOW, NOW + 2 * 3_600_000 - 1)).toBe('quiet')
  expect(activityFor(NOW, NOW + 2 * 3_600_000)).toBe('idle')
})

test('a quiet session polls Slack at the quiet interval and an idle one not at all', async ($, on) => {
  let calls = 0
  on('mcp.call', { server: SLK, tool: 'slack_read_thread' }, () => {
    calls++
    return ok({ messages: [{ ts: '1731150000.123456', user_name: 'alex', text: 'up' }] })
  })
  const { clock, store } = await boot($, on, [ref(THREAD_A, 'slack', THREAD_A)])
  store.put(s => ({ ...s, lastPromptAt: Date.now() - 31 * 60_000 }))
  expect(calls).toBe(1)

  await clock.advance(180_000)
  expect(calls).toBe(2)
  expect(store.get().activity).toBe('quiet')
  await clock.advance(180_000)
  expect(calls).toBe(2)
  await clock.advance(1_200_000 - 180_000)
  expect(calls).toBe(3)

  store.put(s => ({ ...s, lastPromptAt: Date.now() - 2 * 3_600_000 - 60_000 }))
  const before = calls
  await clock.advance(1_200_000 * 2)
  expect(calls).toBe(before)
  expect(store.get().activity).toBe('idle')
})

test('an observed transitionJiraIssue on a tracked key triggers one refresh', async ($, on) => {
  let gets = 0
  on('mcp.call', { server: ATL, tool: 'getJiraIssue' }, () => { gets++; return ok(issueResult('T1')) })
  on('tool.call', () => ({ result: {}, text: 'done' }))
  const { clock } = await boot($, on, [jiraRef(), ref('PROJ-12', 'jira', 'https://example.atlassian.net/browse/PROJ-12', { untracked: true })])
  expect(gets).toBe(1)

  await $.tool.call({ tool: `mcp__${ATL}__getJiraIssue`, cloudId: 'cloud-1', issueIdOrKey: 'PROJ-1234' } as never)
  await $.tool.call({ tool: `mcp__${ATL}__transitionJiraIssue`, cloudId: 'cloud-1', issueIdOrKey: 'PROJ-12345', transitionName: 'Done' } as never)
  await clock.settle()
  expect(gets).toBe(1)

  await $.tool.call({ tool: `mcp__${ATL}__transitionJiraIssue`, cloudId: 'cloud-1', issueIdOrKey: 'PROJ-1234', transitionName: 'Done' } as never)
  await clock.settle()
  expect(gets).toBe(2)
})

test('a PR card comes from gh pr view and a gh pr merge refreshes it, gh pr view does not', async ($, on) => {
  const argvs: string[][] = []
  on('process.run', (_: unknown, e: { argv: readonly string[] }) => {
    argvs.push([...e.argv])
    return { value: { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false, stdout: JSON.stringify({
      state: 'OPEN', title: 'Retry failed uploads', updatedAt: '2026-11-10T09:00:00Z', reviewDecision: 'REVIEW_REQUIRED',
      statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }, { status: 'IN_PROGRESS', conclusion: '' }],
    }) } }
  })
  on('tool.call', () => ({ result: {}, text: '' }))
  const { clock, store } = await boot($, on, [ref('acme/app#412', 'github-pr', 'https://github.com/acme/app/pull/412')])

  expect(argvs).toEqual([['gh', 'pr', 'view', '412', '--repo', 'acme/app', '--json', 'state,title,updatedAt,statusCheckRollup,reviewDecision']])
  expect(store.get().refs['acme/app#412']?.card).toEqual({
    kind: 'github-pr', number: 412, title: 'Retry failed uploads', state: 'open', checks: 'pending', reviewDecision: 'REVIEW_REQUIRED',
  })

  await $.tool.call({ tool: 'Bash', command: 'gh pr view 412 --repo acme/app' })
  await clock.settle()
  expect(argvs.length).toBe(1)
  await $.tool.call({ tool: 'Bash', command: 'gh pr merge 412 --repo acme/app --squash' })
  await clock.settle()
  expect(argvs.length).toBe(2)
})

test('a refused gh stops the scheduled PR poll but a prompt still runs it', async ($, on) => {
  let runs = 0
  on('process.run', () => { runs++; return { deny: 'process.run refused by policy' } })
  on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))
  const { clock, store } = await boot($, on, [ref('acme/app#412', 'github-pr', 'https://github.com/acme/app/pull/412')])

  expect(runs).toBe(1)
  expect(store.get().refs['acme/app#412']?.error).toMatch(/refused/)
  await clock.advance(300_000)
  expect(runs).toBe(1)
  await $.prompt.submit({ text: 'next', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  expect(runs).toBe(2)
})

test('an idle session wakes on a prompt: one refresh at once, then the ticks poll again', async ($, on) => {
  let calls = 0
  on('mcp.call', { server: SLK, tool: 'slack_read_thread' }, () => {
    calls++
    return ok({ messages: [{ ts: '1731150000.123456', user_name: 'alex', text: 'up' }] })
  })
  on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))
  const { clock, store } = await boot($, on, [ref(THREAD_A, 'slack', THREAD_A)])
  expect(calls).toBe(1)
  store.put(s => ({ ...s, lastPromptAt: Date.now() - 3 * 3_600_000 }))

  await clock.advance(180_000)
  expect(store.get().activity).toBe('idle')
  expect(calls).toBe(1)

  await $.prompt.submit({ text: 'back', wait: false, origin: { kind: 'composer' } })
  await clock.settle()
  expect(calls).toBe(2)
  await clock.advance(180_000)
  expect(store.get().activity).toBe('active')
  expect(calls).toBe(3)
})

test('a new ref from a prompt gets its first card at turn.complete, a tool-only one does not', async ($, on) => {
  const gets: string[] = []
  on('mcp.call', { server: ATL, tool: 'getJiraIssue' }, (_: unknown, e: { args: Readonly<Record<string, unknown>> }) => {
    gets.push(String(e.args.issueIdOrKey))
    return ok(issueResult('T1'))
  })
  on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))
  on('tool.call', () => ({ result: {}, text: 'also PROJ-77' }))
  on('turn.complete', () => ({ text: '' }))
  const { clock, store } = await boot($, on, [])

  await $.prompt.submit({ text: 'look at PROJ-1234', wait: false, origin: { kind: 'composer' } })
  await $.tool.call({ tool: 'Bash', command: 'echo' })
  await clock.settle()
  expect(gets).toEqual([])
  await $.turn.complete({ durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1', answer: 'ok' })
  await clock.settle()
  expect(gets).toEqual(['PROJ-1234'])
  expect(store.get().refs['PROJ-1234']?.fingerprint).toBe('T1')

  await $.turn.complete({ durationMs: 1, isAborted: false, reason: 'answer', turnId: 't2', answer: 'ok' })
  await clock.settle()
  expect(gets).toEqual(['PROJ-1234'])
})

test('a slow poll does not overwrite a newer card written while it was fetching', async ($, on) => {
  const msg = (n: number) => ({ ts: `1731150000.${String(123456 + n)}`, user_name: 'alex', text: `m${n}` })
  let calls = 0
  let put: ((change: (s: ContextState) => ContextState) => void) | undefined
  const newer: Card = { kind: 'slack', channel: 'C0AB12CD', replyCount: 3, participants: ['alex'], latest: { author: 'alex', age: '1731150000.123459', text: 'm3' }, newSince: 1 }
  on('mcp.call', { server: SLK, tool: 'slack_read_thread' }, () => {
    calls++
    if (calls === 1) return ok({ messages: [msg(0), msg(1)] })
    put?.(s => ({ ...s, refs: { ...s.refs, [THREAD_A]: { ...s.refs[THREAD_A]!, card: newer, fingerprint: '1731150000.123459:3' } } }))
    return ok({ messages: [msg(0), msg(1), msg(2)] })
  })
  const { clock, store } = await boot($, on, [ref(THREAD_A, 'slack', THREAD_A)])
  put = store.put
  expect(store.get().refs[THREAD_A]?.fingerprint).toBe('1731150000.123457:1')

  await clock.advance(180_000)
  expect(calls).toBe(2)
  expect(store.get().refs[THREAD_A]?.fingerprint).toBe('1731150000.123459:3')
  expect(store.get().refs[THREAD_A]?.card).toEqual(newer)
})

test('a connector absent from the tool list is reached by its claude.ai name', async ($, on) => {
  const servers: string[] = []
  on('mcp.call', { server: 'claude.ai Atlassian', tool: 'getAccessibleAtlassianResources' }, () => ok({ data: { resources: [{ cloudId: 'cloud-1' }] } }))
  on('mcp.call', { server: 'claude.ai Atlassian', tool: 'getJiraIssue' }, (_: unknown, e: { server: string }) => {
    servers.push(e.server)
    return ok(issueResult('T1'))
  })
  const { store } = await boot($, on, [jiraRef()], { tools: () => [] })
  expect(servers).toEqual(['claude.ai Atlassian'])
  expect(store.get().refs['PROJ-1234']?.error).toBeUndefined()
  expect(store.get().refs['PROJ-1234']?.fingerprint).toBe('T1')
})
