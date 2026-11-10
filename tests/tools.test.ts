import { test, expect, mock } from 'claude-code/testing'
import type { ContextState, Ref } from '../types'
import { primary } from '../hooks/store'
import { onPaneClose } from '../hooks/tools'

type Wrapped = { shape: string; value: ContextState }

const PR_URL = 'https://github.com/acme/app/pull/412'
const NOW = 1_800_000_000_000

const ref = (id: string, extra: Partial<Ref> = {}): Ref => ({
  id, kind: 'jira', href: `https://example.atlassian.net/browse/${id}`, firstSeen: 1, lastSeen: 1, mentions: 1,
  sources: ['prompt'], snippet: '', score: 0.2, why: '', pinned: false, untracked: false, notes: [], ...extra,
})

const boot = async ($: any, on: any, refs: Ref[], isClosed?: boolean) => {
  const clock = mock.clock(on, { now: NOW })
  let held: Wrapped = { shape: 'context-1', value: { refs: Object.fromEntries(refs.map(r => [r.id, r])), activity: 'active', lastPromptAt: NOW } }
  let closed: { shape: string; value: boolean } | undefined = isClosed === undefined ? undefined : { shape: 'closed-1', value: isClosed }
  let version = 0
  on('state.get', (_: unknown, e: { key: string }) => ({
    value: { value: e.key === 'state' ? held : closed, version },
  }))
  on('state.set', (_: unknown, e: { key: string; value: any }) => {
    if (e.key === 'state') held = e.value
    else closed = e.value
    version += 1
    return { value: { isSet: true, version } }
  })
  const registered: Array<{ name: string; isDeferred?: boolean; inputSchema?: any }> = []
  const commands: string[] = []
  on('tool.register', (_: unknown, e: any) => {
    registered.push(e.tool ?? e)
    return { value: { tool: `mcp__quick-refs__${(e.tool ?? e).name}` } }
  })
  on('command.register', (_: unknown, e: any) => {
    commands.push((e.command ?? e).name)
    return { value: { command: (e.command ?? e).name } }
  })
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('session.messages', () => ({ value: [] }))
  on('tool.list', () => ({ value: [] }))
  await $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true })
  await clock.settle()
  return { state: () => held.value, closed: () => closed?.value, registered, commands }
}

test('registers note and pin eagerly, track untrack refresh deferred, and the three commands', async ($, on) => {
  const h = await boot($, on, [])
  const by = Object.fromEntries(h.registered.map(t => [t.name, t]))
  expect(Object.keys(by).sort()).toEqual(['note', 'pin', 'refresh', 'track', 'untrack'])
  expect(by.note?.isDeferred).toBe(false)
  expect(by.pin?.isDeferred).toBe(false)
  expect(by.track?.isDeferred).toBeUndefined()
  expect(by.note?.inputSchema.required).toEqual(['ref', 'text', 'kind'])
  expect(h.commands.sort()).toEqual(['quick-refs', 'track', 'untrack'])
})

test('note attaches to a tracked ref and answers with text', async ($, on) => {
  const h = await boot($, on, [ref('PROJ-1234')])
  const r = await $.tool.call({ tool: 'mcp__quick-refs__note', ref: 'PROJ-1234', text: 'add a retry test', kind: 'action' } as never)
  expect(r.text).toBe('noted on PROJ-1234')
  const notes = h.state().refs['PROJ-1234']?.notes
  expect(notes).toHaveLength(1)
  expect(notes?.[0]).toMatchObject({ text: 'add a retry test', kind: 'action', done: false })
})

test('pin makes a low-score ref primary', async ($, on) => {
  const h = await boot($, on, [ref('PROJ-1', { score: 0.9 }), ref('PROJ-2', { score: 0.1 })])
  const r = await $.tool.call({ tool: 'mcp__quick-refs__pin', ref: 'PROJ-2' } as never)
  expect(r.text).toBe('pinned PROJ-2')
  expect(h.state().refs['PROJ-2']?.pinned).toBe(true)
  expect(primary(h.state()).jira?.id).toBe('PROJ-2')
})

test('track of a url the session never saw adds it with source manual', async ($, on) => {
  const h = await boot($, on, [])
  const r = await $.tool.call({ tool: 'mcp__quick-refs__track', ref: PR_URL } as never)
  expect(r.text).toBe('tracking acme/app#412')
  const added = h.state().refs['acme/app#412']
  expect(added?.sources).toEqual(['manual'])
  expect(added?.untracked).toBe(false)
})

test('/untrack hides a ref and a later tool mention does not revive it, while a tracked ref gains the mention', async ($, on) => {
  const PR_B = 'https://github.com/acme/app/pull/413'
  on('tool.call', { tool: 'Bash' }, () => ({ result: {}, text: `merged ${PR_URL} and ${PR_B}` }))
  const h = await boot($, on, [
    ref('acme/app#412', { kind: 'github-pr', href: PR_URL }),
    ref('acme/app#413', { kind: 'github-pr', href: PR_B }),
  ])
  const r = await $.command.run({ command: 'untrack', args: 'acme/app#412' } as never)
  expect(r.text).toBe('untracked acme/app#412')
  expect(h.state().refs['acme/app#412']?.untracked).toBe(true)
  await $.tool.call({ tool: 'Bash', command: 'echo' })
  expect(h.state().refs['acme/app#413']?.mentions).toBe(2)
  expect(h.state().refs['acme/app#412']?.untracked).toBe(true)
})

test('refresh of an unknown ref says so', async ($, on) => {
  await boot($, on, [])
  const r = await $.tool.call({ tool: 'mcp__quick-refs__refresh', ref: 'PROJ-9' } as never)
  expect(r.text).toBe('PROJ-9 is not tracked')
})

test('refresh of a ref whose connector is missing replies with the error', async ($, on) => {
  await boot($, on, [ref('PROJ-1234')])
  const r = await $.tool.call({ tool: 'mcp__quick-refs__refresh', ref: 'PROJ-1234' } as never)
  expect(r.text).toBe('refreshed PROJ-1234: not connected: Atlassian, run /mcp')
})

test('/quick-refs reopens the pane and clears the close flag', async ($, on) => {
  const h = await boot($, on, [], true)
  expect(h.closed()).toBe(true)
  const r = await $.command.run({ command: 'quick-refs' } as never)
  expect(r.text).toBe('Quick refs opened.')
  expect(h.closed()).toBe(false)
})

const stateDouble = () => {
  const held: Record<string, { value: unknown; version: number }> = {}
  const $ = {
    state: {
      get: async (ref: { key: string }) => ({ value: held[ref.key]?.value, version: held[ref.key]?.version ?? 0 }),
      set: async (ref: { key: string }, value: unknown) => {
        const version = (held[ref.key]?.version ?? 0) + 1
        held[ref.key] = { value, version }
        return { isSet: true, version }
      },
    },
  }
  return { $: $ as never, closed: () => (held.isClosedByPerson?.value as { value: boolean } | undefined)?.value }
}

test('closing the pane by the person is remembered, other closes are not', async () => {
  const { $, closed } = stateDouble()
  let nexts = 0
  const next = async (e: unknown) => {
    nexts += 1
    return e
  }
  await onPaneClose($, { id: 'refs', origin: { kind: 'plugin' } }, next)
  await onPaneClose($, { id: 'refs', origin: { kind: 'unload' } }, next)
  await onPaneClose($, { id: 'other', origin: { kind: 'person' } }, next)
  expect(closed()).toBeUndefined()
  await onPaneClose($, { id: 'refs', origin: { kind: 'person' } }, next)
  expect(closed()).toBe(true)
  expect(nexts).toBe(4)
})
