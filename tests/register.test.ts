import { test, expect, mock } from 'claude-code/testing'
import type { ContextState, Ref } from '../types'
import { shouldOpenUnasked } from '../hooks/tools'

const NOW = 1_800_000_000_000

const ref = (id: string): Ref => ({
  id, kind: 'jira', href: `https://example.atlassian.net/browse/${id}`, firstSeen: 1, lastSeen: 1, mentions: 1,
  sources: ['prompt'], snippet: '', score: 0.2, why: '', pinned: false, untracked: false, notes: [],
})

const boot = async ($: any, on: any, surface: string, opts: { refs?: Ref[]; isClosed?: boolean } = {}) => {
  const clock = mock.clock(on, { now: NOW })
  let held: { shape: string; value: ContextState } = {
    shape: 'context-1',
    value: { refs: Object.fromEntries((opts.refs ?? []).map(r => [r.id, r])), activity: 'active', lastPromptAt: NOW },
  }
  const closed = opts.isClosed === undefined ? undefined : { shape: 'closed-1', value: opts.isClosed }
  on('state.get', (_: unknown, e: { key: string }) => ({ value: { value: e.key === 'state' ? held : closed, version: 0 } }))
  on('state.set', (_: unknown, e: { key: string; value: any }) => {
    if (e.key === 'state') held = e.value
    return { value: { isSet: true, version: 1 } }
  })
  on('tool.register', (_: unknown, e: any) => ({ value: { tool: `mcp__quick-refs__${(e.tool ?? e).name}` } }))
  on('command.register', (_: unknown, e: any) => ({ value: { command: (e.command ?? e).name } }))
  const opened: string[] = []
  on('ui.open', (_: unknown, e: any) => {
    opened.push((e.pane ?? e).id)
    return { value: { isPlaced: true } }
  })
  on('session.start', (_: unknown, e: { cwd: string }) => ({ cwd: e.cwd }))
  on('fs.read', () => ({ deny: 'ENOENT' }))
  on('session.messages', () => ({ value: [] }))
  on('tool.list', () => ({ value: [] }))
  await $.session.start({ cwd: '/repo', surface, isInteractive: true })
  await clock.settle()
  return { opened, state: () => held.value }
}

test('shouldOpenUnasked is true only on desktop while the person has not closed the pane', () => {
  expect(shouldOpenUnasked('desktop', false)).toBe(true)
  expect(shouldOpenUnasked('desktop', true)).toBe(false)
  expect(shouldOpenUnasked('terminal', false)).toBe(false)
  expect(shouldOpenUnasked(null, false)).toBe(false)
})

test('session.start opens the pane on desktop, not in the terminal', async ($, on) => {
  const h = await boot($, on, 'desktop')
  expect(h.opened).toEqual(['refs'])
})

test('session.start leaves the terminal pane for /quick-refs', async ($, on) => {
  const h = await boot($, on, 'terminal')
  expect(h.opened).toEqual([])
})

test('a reload keeps the store and does not reopen a pane the person closed', async ($, on) => {
  const h = await boot($, on, 'desktop', { refs: [ref('PROJ-1234')], isClosed: true })
  expect(h.opened).toEqual([])
  expect(h.state().refs['PROJ-1234']).toBeDefined()
})
