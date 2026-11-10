import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { ContextState, Ref } from '../types'
import { EMPTY, STATE_SHAPE, applyScores, setHash, trackedIds } from './store'

const state = atom({ plugin: 'context-pane', key: 'state' } as const, EMPTY, { shape: STATE_SHAPE })

const RECENCY_WINDOW_MS = 7_200_000
const DEBOUNCE_MS = 300_000
const WHY_MAX = 40
const TOOL_ONLY_MAX = 0.2
const JIRA_KEY = /[A-Z][A-Z0-9]+-\d+/
const FENCE = /^```(?:json)?\s*([\s\S]*?)\s*```$/

export const CURATE_SYSTEM = [
  'You rank references (Jira issues, pull requests, Slack threads, branches) by relevance to the work this coding session is doing right now.',
  'Reply with JSON only, no prose and no code fence: an object whose keys are exactly the given ids.',
  'Each value is {"score": <number from 0 to 1, 1 = central to the current work>, "why": <string of at most 40 characters>}.',
].join('\n')

type Scores = Record<string, { score: number; why: string }>

export const heuristic = (ref: Ref, s: ContextState, now: number): number => {
  const branchKey = s.branch?.match(JIRA_KEY)?.[0]
  const isBranchPr = ref.kind === 'github-pr' && ref.sources.includes('branch')
  const isBranch = ref.kind === 'branch' && ref.id === s.branch
  if (isBranch || isBranchPr || (branchKey !== undefined && ref.kind === 'jira' && ref.id === branchKey)) return 1
  const recency = Math.max(0, 1 - (now - ref.lastSeen) / RECENCY_WINDOW_MS)
  const score = 0.4 * recency + (0.4 * Math.min(ref.mentions, 5)) / 5 + (ref.sources.includes('prompt') ? 0.2 : 0)
  return ref.sources.every(src => src === 'tool') ? Math.min(score, TOOL_ONLY_MAX) : score
}

const minutesAgo = (now: number, at: number): number => Math.round((now - at) / 60_000)

export const digest = (s: ContextState, now: number): string => {
  const ids = new Set(trackedIds(s))
  const lines = Object.values(s.refs)
    .filter(r => ids.has(r.id))
    .map(r => `${r.kind} ${r.id} mentions=${r.mentions} sources=${r.sources.join(',')} first=${minutesAgo(now, r.firstSeen)}m last=${minutesAgo(now, r.lastSeen)}m :: ${r.snippet}`)
  return [...(s.branch ? [`branch=${s.branch}`] : []), ...lines].join('\n')
}

export const parseScores = (text: string, ids: string[]): Scores | undefined => {
  const trimmed = text.trim()
  const raw = FENCE.exec(trimmed)?.[1] ?? trimmed
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return undefined
  const known = new Set(ids)
  const out: Scores = {}
  for (const [id, v] of Object.entries(parsed)) {
    if (!known.has(id)) continue
    const { score, why } = (v ?? {}) as { score?: unknown; why?: unknown }
    if (typeof score !== 'number' || !Number.isFinite(score)) return undefined
    out[id] = { score: Math.min(1, Math.max(0, score)), why: typeof why === 'string' ? why.slice(0, WHY_MAX) : '' }
  }
  return out
}

export async function maybeCurate($: EngineInterface, now: number): Promise<void> {
  const s = await read($, state)
  const ids = trackedIds(s)
  if (ids.length === 0) return
  const hash = setHash(ids)
  if (hash === s.lastCuratedSetHash) return
  if (s.lastCuratedAt !== undefined && now - s.lastCuratedAt < DEBOUNCE_MS) return

  let scores: Scores | undefined
  try {
    const r = await $.model.complete({ model: 'claude-haiku-5-5', system: CURATE_SYSTEM, prompt: digest(s, now), maxTokens: 400 })
    if (r.isAnswered) scores = parseScores(r.text, ids)
  } catch {
    scores = undefined
  }
  const chosen = scores ?? Object.fromEntries(ids.map(id => [id, { score: heuristic(s.refs[id]!, s, now), why: '' }]))
  await update($, state, cur => applyScores(cur, chosen, hash, now))
}

export async function onTurnCompleteCurate($: EngineInterface, e: { agentId?: string }, next: (e: any) => Promise<any>) {
  if (!e.agentId) await maybeCurate($, Date.now()).catch(() => {})
  return next(e)
}
