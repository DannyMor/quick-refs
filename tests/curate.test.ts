import { test, expect } from 'claude-code/testing'
import type { ContextState, Ref } from '../types'
import { heuristic, parseScores } from '../hooks/curate'

type Wrapped = { shape: string; value: ContextState }

const memoryState = (on: any, initial: ContextState): (() => ContextState) => {
  let held: Wrapped = { shape: 'context-1', value: initial }
  let version = 0
  on('state.get', () => ({ value: { value: held, version } }))
  on('state.set', (_: unknown, e: { value: Wrapped }) => {
    held = e.value
    version += 1
    return { value: { isSet: true, version } }
  })
  return () => held.value
}

const NOW = Date.now()
const ref = (id: string, extra: Partial<Ref> = {}): Ref => ({
  id, kind: 'jira', href: `https://x/${id}`, firstSeen: NOW, lastSeen: NOW, mentions: 1, sources: ['answer'], snippet: `see ${id}`,
  score: 0.5, why: '', pinned: false, untracked: false, notes: [], ...extra,
})
const stateOf = (refs: Ref[], extra: Partial<ContextState> = {}): ContextState => ({
  refs: Object.fromEntries(refs.map(r => [r.id, r])), activity: 'active', lastPromptAt: NOW, ...extra,
})
const usage = { input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const turn = { durationMs: 1, isAborted: false, reason: 'answer', turnId: 't1' } as const

test('heuristic gives the branch key and its PR 1.0 and a tool-only old ref near 0', () => {
  const s = stateOf([], { branch: 'PROJ-5-fix' })
  expect(heuristic(ref('PROJ-5'), s, NOW)).toBe(1)
  expect(heuristic(ref('acme/app#9', { kind: 'github-pr', sources: ['branch'] }), s, NOW)).toBe(1)
  const old = ref('PROJ-6', { sources: ['tool'], lastSeen: NOW - 7_200_000 })
  expect(heuristic(old, s, NOW)).toBeLessThan(0.09)
  const fresh = ref('PROJ-7', { sources: ['prompt'], mentions: 9 })
  expect(heuristic(fresh, s, NOW)).toBeGreaterThan(0.99)
})

test('parseScores drops unknown ids, clamps, truncates why and returns undefined on bad json', () => {
  const text = JSON.stringify({ A: { score: 3, why: 'x'.repeat(60) }, B: { score: -1, why: 'low' }, Z: { score: 0.5, why: 'unknown' } })
  expect(parseScores(text, ['A', 'B'])).toEqual({ A: { score: 1, why: 'x'.repeat(40) }, B: { score: 0, why: 'low' } })
  expect(parseScores('```json\n{"A":{"score":0.2,"why":"w"}}\n```', ['A'])).toEqual({ A: { score: 0.2, why: 'w' } })
  expect(parseScores('not json', ['A'])).toBeUndefined()
  expect(parseScores('[1]', ['A'])).toBeUndefined()
})

test('maybeCurate calls the model once for a changed set and not again within 5 minutes', async ($, on) => {
  const stored = memoryState(on, stateOf([ref('PROJ-1')]))
  let calls = 0
  on('model.complete', () => {
    calls++
    return { value: { isAnswered: true as const, text: '{"PROJ-1":{"score":0.9,"why":"primary"}}', usage } }
  })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ ...turn, answer: 'nothing new' })
  expect(calls).toBe(1)
  expect(stored().refs['PROJ-1']).toMatchObject({ score: 0.9, why: 'primary' })
  await $.turn.complete({ ...turn, answer: 'nothing new again' })
  expect(calls).toBe(1)
  await $.turn.complete({ ...turn, answer: 'now PROJ-2 appears' })
  expect(calls).toBe(1)
  expect(stored().refs['PROJ-2']).toBeDefined()
})

test('a non-json answer falls back to heuristic scores and records the set hash', async ($, on) => {
  const stored = memoryState(on, stateOf([ref('PROJ-1', { sources: ['prompt'], mentions: 5 })], { lastCuratedAt: NOW - 600_000, lastCuratedSetHash: 'old' }))
  on('model.complete', () => ({ value: { isAnswered: true as const, text: 'sorry, here is prose', usage } }))
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ ...turn, answer: 'x' })
  expect(stored().refs['PROJ-1']?.score).toBeGreaterThan(0.99)
  expect(stored().lastCuratedSetHash).toBe('PROJ-1')
})

test('an unanswered model call falls back to heuristic scores', async ($, on) => {
  const stored = memoryState(on, stateOf([ref('PROJ-1', { sources: ['tool'], lastSeen: NOW - 7_200_000 })]))
  on('model.complete', () => ({ value: { isAnswered: false as const, reason: 'api-error' as const, status: 529, error: 'overloaded' as const, usage } }))
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ ...turn, answer: 'x' })
  expect(stored().refs['PROJ-1']?.score).toBeLessThan(0.1)
  expect(stored().lastCuratedSetHash).toBe('PROJ-1')
})

test('a subagent turn does not curate', async ($, on) => {
  const stored = memoryState(on, stateOf([ref('PROJ-1')]))
  let calls = 0
  on('model.complete', () => {
    calls++
    return { value: { isAnswered: true as const, text: '{"PROJ-1":{"score":0.9,"why":"primary"}}', usage } }
  })
  on('turn.complete', () => ({ text: '' }))
  await $.turn.complete({ ...turn, answer: 'x', agentId: 'a1' })
  expect(calls).toBe(0)
  expect(stored().lastCuratedSetHash).toBeUndefined()
})

test('heuristic gives the current branch ref 1.0', () => {
  const s = stateOf([], { branch: 'feature/x' })
  expect(heuristic(ref('feature/x', { kind: 'branch', sources: ['branch'] }), s, NOW)).toBe(1)
})
