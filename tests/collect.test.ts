import { test, expect, mock } from 'claude-code/testing'
import type { ContextState } from '../types'

type Wrapped = { shape: string; value: ContextState }

const memoryState = (on: any, initial?: ContextState): (() => ContextState | undefined) => {
  let held: Wrapped | undefined = initial && { shape: 'context-1', value: initial }
  let version = 0
  on('state.get', () => ({ value: { value: held, version } }))
  on('state.set', (_: unknown, e: { value: Wrapped; ifVersion?: number }) => {
    if (e.ifVersion !== undefined && e.ifVersion !== version) return { value: { isSet: false, version } }
    held = e.value
    version += 1
    return { value: { isSet: true, version } }
  })
  return () => held?.value
}

const startSession = async ($: any, on: any, files: Record<string, string>, messages: unknown[] = []) => {
  on('command.register', () => ({ value: { command: 'context-pane' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__context-pane__note' } }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('fs.read', (_: unknown, e: { path: string }) => {
    const text = files[e.path]
    if (text === undefined) throw new Error(`ENOENT ${e.path}`)
    return { value: text }
  })
  on('session.messages', () => ({ value: messages }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
}

test('a prompt mentioning PROJ-1234 lands in the store with source prompt', async ($, on) => {
  const stored = memoryState(on)
  on('prompt.submit', (_, e) => ({ text: e.text }))
  await $.prompt.submit({ text: 'look at PROJ-1234', wait: false, origin: { kind: 'composer' } })
  const s = stored()
  expect(s?.refs['PROJ-1234']?.sources).toEqual(['prompt'])
  expect(s?.lastPromptAt).toBeGreaterThan(0)
})

test('a tool result mentioning a PR url lands with source tool at score 0.2', async ($, on) => {
  const stored = memoryState(on)
  on('tool.call', () => ({ result: {}, text: 'merged https://github.com/acme/app/pull/412 today' }))
  await $.tool.call({ tool: 'Bash', command: 'gh pr list' })
  const ref = (stored())?.refs['acme/app#412']
  expect(ref?.sources).toEqual(['tool'])
  expect(ref?.score).toBe(0.2)
})

test('the plugin own tools are not scanned', async ($, on) => {
  const stored = memoryState(on)
  on('tool.call', () => ({ result: {}, text: 'PROJ-77' }))
  await $.tool.call({ tool: 'mcp__context-pane__score', note: 'PROJ-77' } as never)
  expect((stored())?.refs['PROJ-77']).toBeUndefined()
})

test('a main answer is scanned and a subagent answer is not', async ($, on) => {
  const stored = memoryState(on)
  on('turn.complete', () => ({ text: '' }))
  const turn = { durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1' } as const
  await $.turn.complete({ ...turn, answer: 'fixed in PROJ-8' })
  await $.turn.complete({ ...turn, answer: 'agent saw PROJ-9', agentId: 'a1' })
  const refs = (stored())?.refs ?? {}
  expect(refs['PROJ-8']?.sources).toEqual(['answer'])
  expect(refs['PROJ-9']).toBeUndefined()
})

test('readBranch follows a worktree gitdir file and a detached head gives no branch', async ($, on) => {
  const stored = memoryState(on)
  await startSession($, on, {
    '/repo/.git': 'gitdir: /tmp/wt/.git/worktrees/x\n',
    '/tmp/wt/.git/worktrees/x/HEAD': 'ref: refs/heads/PROJ-7-fix\n',
  })
  const s = stored()
  expect(s?.branch).toBe('PROJ-7-fix')
  expect(s?.refs['PROJ-7']?.sources).toEqual(['branch'])
})

test('a detached head and a missing .git leave the branch unset', async ($, on) => {
  const stored = memoryState(on)
  await startSession($, on, { '/repo/.git/HEAD': 'abc123def\n' })
  expect((stored())?.branch).toBeUndefined()
})

test('a plain checkout reads the branch from .git/HEAD', async ($, on) => {
  const stored = memoryState(on)
  await startSession($, on, { '/repo/.git/HEAD': 'ref: refs/heads/feature/no-key\n' })
  const s = stored()
  expect(s?.branch).toBe('feature/no-key')
  expect(Object.keys(s?.refs ?? {})).toEqual(['feature/no-key'])
})

test('session.start adds the branch as a ref linked to the GitHub tree and the branch PR with source branch', async ($, on) => {
  const stored = memoryState(on)
  const runs: Array<{ argv: string[]; cwd?: string }> = []
  on('session.repo', () => ({ value: { root: '/repo', remote: 'git@github.com:acme/app.git', internal: false, name: 'acme/app' } }))
  on('process.run', (_: unknown, e: { argv: readonly string[]; init?: { cwd?: string } }) => {
    runs.push({ argv: [...e.argv], cwd: e.init?.cwd })
    return { value: { exitCode: 0, stderr: '', isStdoutTruncated: false, isStderrTruncated: false,
      stdout: JSON.stringify({ number: 412, url: 'https://github.com/acme/app/pull/412' }) } }
  })
  const clock = mock.clock(on, { now: Date.now() })
  await startSession($, on, { '/repo/.git/HEAD': 'ref: refs/heads/PROJ-1234-upload-retry\n' })
  await clock.settle()
  const s = stored()
  expect(s?.refs['PROJ-1234-upload-retry']).toMatchObject({
    kind: 'branch', href: 'https://github.com/acme/app/tree/PROJ-1234-upload-retry', sources: ['branch'], score: 1,
  })
  expect(runs.filter(r => r.argv.includes('number,url'))).toEqual([{ argv: ['gh', 'pr', 'view', '--json', 'number,url'], cwd: '/repo' }])
  expect(s?.refs['acme/app#412']).toMatchObject({ kind: 'github-pr', href: 'https://github.com/acme/app/pull/412', sources: ['branch'] })
})

test('a branch without a GitHub remote links to # and a failing gh adds no PR', async ($, on) => {
  const stored = memoryState(on)
  on('session.repo', () => ({ value: null }))
  on('process.run', () => ({ deny: 'gh missing' }))
  await startSession($, on, { '/repo/.git/HEAD': 'ref: refs/heads/main\n' })
  const refs = stored()?.refs ?? {}
  expect(refs['main']).toMatchObject({ kind: 'branch', href: '#', sources: ['branch'] })
  expect(Object.keys(refs)).toEqual(['main'])
})

test('a prompt re-reads the branch and adds the new one when it changed', async ($, on) => {
  const stored = memoryState(on)
  const files: Record<string, string> = { '/repo/.git/HEAD': 'ref: refs/heads/one\n' }
  on('prompt.submit', (_: unknown, e: { text: string }) => ({ text: e.text }))
  await startSession($, on, files)
  files['/repo/.git/HEAD'] = 'ref: refs/heads/PROJ-9-two\n'
  await $.prompt.submit({ text: 'go on', wait: false, origin: { kind: 'composer' } })
  const s = stored()
  expect(s?.branch).toBe('PROJ-9-two')
  expect(s?.refs['PROJ-9-two']).toMatchObject({ kind: 'branch', sources: ['branch'] })
  expect(s?.refs['PROJ-9']?.sources).toEqual(['branch'])
  expect(s?.refs['one']?.mentions).toBe(1)
})

test('session.start marks a fresh session active from now', async ($, on) => {
  const stored = memoryState(on)
  const before = Date.now()
  await startSession($, on, {})
  const s = stored()
  expect(s?.lastPromptAt).toBeGreaterThanOrEqual(before)
  expect(s?.activity).toBe('active')
})

test('replay rebuilds refs from the transcript with heuristic scores', async ($, on) => {
  const stored = memoryState(on)
  await startSession($, on, {}, [
    { role: 'user', text: 'work on PROJ-1', toolUses: [] },
    {
      role: 'assistant', text: 'see PROJ-2',
      toolUses: [{ tool_use_id: 'u1', tool: 'Bash', input: { command: 'gh pr view https://github.com/acme/app/pull/9' }, text: 'blocked by PROJ-3' }],
    },
  ])
  const s = stored()
  const refs = s?.refs ?? {}
  expect(refs['PROJ-1']?.sources).toEqual(['prompt'])
  expect(Math.abs((refs['PROJ-1']?.score ?? 0) - 0.68)).toBeLessThan(0.001)
  expect(refs['PROJ-2']?.sources).toEqual(['answer'])
  expect(Math.abs((refs['PROJ-2']?.score ?? 0) - 0.48)).toBeLessThan(0.001)
  expect(refs['acme/app#9']?.sources).toEqual(['tool'])
  expect(refs['acme/app#9']?.score).toBe(0.2)
  expect(refs['PROJ-3']?.score).toBe(0.2)
  expect(s?.lastCuratedSetHash).toBe('PROJ-1|PROJ-2|PROJ-3|acme/app#9')
})

test('replay skips the plugin own tools', async ($, on) => {
  const stored = memoryState(on)
  await startSession($, on, {}, [
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: 'u1', tool: 'mcp__context-pane__note', input: { id: 'PROJ-55' }, text: 'noted PROJ-55' }] },
  ])
  expect(stored()?.refs['PROJ-55']).toBeUndefined()
})

test('replay does not run again over refs a reload kept', async ($, on) => {
  const seeded: ContextState = {
    refs: {
      'PROJ-1': {
        id: 'PROJ-1', kind: 'jira', href: 'https://example.atlassian.net/browse/PROJ-1', firstSeen: 1, lastSeen: 1, mentions: 1,
        sources: ['prompt'], snippet: '', score: 0.5, why: '', pinned: false, untracked: false, notes: [],
      },
    },
    activity: 'active', lastPromptAt: 0,
  }
  const stored = memoryState(on, seeded)
  await startSession($, on, {}, [{ role: 'user', text: 'work on PROJ-1', toolUses: [] }])
  expect(stored()?.refs['PROJ-1']?.mentions).toBe(1)
})

test('a failing transcript read still lets the session start open the pane', async ($, on) => {
  let opened = false
  let reachedNext = false
  on('command.register', () => ({ value: { command: 'context-pane' } }))
  on('tool.register', () => ({ value: { tool: 'mcp__context-pane__note' } }))
  on('ui.open', () => {
    opened = true
    return { value: { isPlaced: true } }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => {
    reachedNext = true
    return { cwd: e.cwd }
  })
  on('fs.read', () => { throw new Error('ENOENT') })
  on('session.messages', () => { throw new Error('transcript unavailable') })
  await $.session.start({ cwd: '/repo', surface: 'desktop', isInteractive: true })
  expect(reachedNext).toBe(true)
  expect(opened).toBe(true)
})

test('a failing scan in turn.complete still reaches the next hook', async ($, on) => {
  on('state.get', () => { throw new Error('store down') })
  on('state.set', () => { throw new Error('store down') })
  let reachedNext = false
  on('turn.complete', () => {
    reachedNext = true
    return { text: '' }
  })
  await $.turn.complete({ durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1', answer: 'see PROJ-5' })
  expect(reachedNext).toBe(true)
})

test('a compaction summary is replayed as tool text, never as a prompt', async ($, on) => {
  const stored = memoryState(on)
  await startSession($, on, {}, [
    { role: 'user', text: 'This session is being continued from a previous conversation. Earlier: PROJ-77', toolUses: [] },
  ])
  expect(stored()?.refs['PROJ-77']?.sources).toEqual(['tool'])
})
