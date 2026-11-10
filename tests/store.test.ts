import { test, expect } from 'claude-code/testing'
import { EMPTY, upsertRef, applyScores, pin, untrack, primary, also } from '../hooks/store'
import type { Found } from '../types'

const jira = (id: string): Found => ({ id, kind: 'jira', href: `https://example.atlassian.net/browse/${id}`, snippet: `work on ${id}` })
const pr = (n: number): Found => ({ id: `acme/app#${n}`, kind: 'github-pr', href: `https://github.com/acme/app/pull/${n}`, snippet: `pr ${n}` })

test('upsert counts mentions and keeps the first source order', () => {
  let s = upsertRef(EMPTY, jira('PROJ-1'), 'prompt', 1000)
  s = upsertRef(s, jira('PROJ-1'), 'tool', 2000)
  const r = s.refs['PROJ-1']
  expect(r?.mentions).toEqual(2)
  expect(r?.sources).toEqual(['prompt', 'tool'])
  expect(r?.score).toEqual(0.5)
  expect(r?.firstSeen).toEqual(1000)
  expect(r?.lastSeen).toEqual(2000)
  expect(EMPTY.refs).toEqual({})
})

test('a tool-only ref starts at 0.2', () => {
  const s = upsertRef(EMPTY, jira('PROJ-2'), 'tool', 1000)
  const r = s.refs['PROJ-2']
  expect(r?.score).toEqual(0.2)
  expect(r?.mentions).toEqual(1)
  expect(r?.pinned).toEqual(false)
  expect(r?.untracked).toEqual(false)
  expect(r?.notes).toEqual([])
})

test('untracked refs are revived only by a prompt or manual source', () => {
  let s = upsertRef(EMPTY, jira('PROJ-3'), 'prompt', 1000)
  s = untrack(s, 'PROJ-3')
  expect(s.refs['PROJ-3']?.untracked).toEqual(true)
  s = upsertRef(s, jira('PROJ-3'), 'tool', 2000)
  expect(s.refs['PROJ-3']?.untracked).toEqual(true)
  s = upsertRef(s, jira('PROJ-3'), 'answer', 3000)
  expect(s.refs['PROJ-3']?.untracked).toEqual(true)
  s = upsertRef(s, jira('PROJ-3'), 'prompt', 4000)
  expect(s.refs['PROJ-3']?.untracked).toEqual(false)
  s = untrack(s, 'PROJ-3')
  s = upsertRef(s, jira('PROJ-3'), 'manual', 5000)
  expect(s.refs['PROJ-3']?.untracked).toEqual(false)
})

test('applyScores ignores ids not in the store and stores the hash', () => {
  const s0 = upsertRef(EMPTY, jira('PROJ-4'), 'tool', 1000)
  const s = applyScores(s0, { 'PROJ-4': { score: 0.9, why: 'main ticket' }, 'PROJ-99': { score: 1, why: 'ghost' } }, 'h1', 5000)
  expect(Object.keys(s.refs)).toEqual(['PROJ-4'])
  expect(s.refs['PROJ-4']?.score).toEqual(0.9)
  expect(s.refs['PROJ-4']?.why).toEqual('main ticket')
  expect(s.lastCuratedSetHash).toEqual('h1')
  expect(s.lastCuratedAt).toEqual(5000)
})

test('primary picks pinned over score and also excludes primaries and untracked', () => {
  let s = upsertRef(EMPTY, jira('PROJ-5'), 'prompt', 1000)
  s = upsertRef(s, jira('PROJ-6'), 'prompt', 1000)
  s = upsertRef(s, jira('PROJ-7'), 'prompt', 1000)
  s = upsertRef(s, pr(1), 'prompt', 1000)
  s = applyScores(s, { 'PROJ-5': { score: 0.9, why: '' }, 'PROJ-6': { score: 0.3, why: '' }, 'PROJ-7': { score: 0.95, why: '' } }, 'h', 2000)
  s = pin(s, 'PROJ-6')
  s = untrack(s, 'PROJ-7')
  const p = primary(s)
  expect(p.jira?.id).toEqual('PROJ-6')
  expect(p.pr?.id).toEqual('acme/app#1')
  expect(p.slack).toBeUndefined()
  expect(also(s).map(r => r.id)).toEqual(['PROJ-5'])
})

test('also is capped at 6 and ordered pinned, score, lastSeen', () => {
  let s = upsertRef(EMPTY, jira('PROJ-100'), 'prompt', 1000)
  const scores: Record<string, { score: number; why: string }> = { 'PROJ-100': { score: 1, why: '' } }
  for (let i = 1; i <= 8; i++) {
    s = upsertRef(s, jira(`PROJ-${i}`), 'prompt', 1000 + i)
    scores[`PROJ-${i}`] = { score: 0.5, why: '' }
  }
  scores['PROJ-2'] = { score: 0.8, why: '' }
  s = applyScores(s, scores, 'h', 2000)
  s = pin(s, 'PROJ-1')
  s = pin(s, 'PROJ-3')
  expect(primary(s).jira?.id).toEqual('PROJ-3')
  const ids = also(s).map(r => r.id)
  expect(ids.length).toEqual(6)
  expect(ids).toEqual(['PROJ-1', 'PROJ-100', 'PROJ-2', 'PROJ-8', 'PROJ-7', 'PROJ-6'])
})

test('a tool-only ref below 0.3 never takes a primary slot', () => {
  let s = upsertRef(EMPTY, pr(7), 'tool', 1000)
  expect(s.refs['acme/app#7']?.score).toEqual(0.2)
  expect(primary(s).pr).toBeUndefined()
  expect(also(s).map(r => r.id)).toEqual(['acme/app#7'])
  s = applyScores(s, { 'acme/app#7': { score: 0.3, why: '' } }, 'h', 2000)
  expect(primary(s).pr?.id).toEqual('acme/app#7')
})
