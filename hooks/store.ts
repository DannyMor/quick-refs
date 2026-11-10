import type { Activity, Card, ContextState, Found, Note, Ref, Source } from '../types'

export const EMPTY: ContextState = { refs: {}, activity: 'active', lastPromptAt: 0 }

export const STATE_SHAPE = 'context-1'

const patch = (s: ContextState, id: string, change: (r: Ref) => Ref): ContextState => {
  const r = s.refs[id]
  return r ? { ...s, refs: { ...s.refs, [id]: change(r) } } : s
}

export const upsertRef = (s: ContextState, found: Found, source: Source, now: number): ContextState => {
  const existing = s.refs[found.id]
  if (!existing) {
    const ref: Ref = {
      id: found.id, kind: found.kind, href: found.href, firstSeen: now, lastSeen: now, mentions: 1,
      sources: [source], snippet: found.snippet, score: source === 'tool' ? 0.2 : source === 'manual' ? MANUAL_MIN_SCORE : 0.5, why: '',
      pinned: false, untracked: false, notes: [],
    }
    return { ...s, refs: { ...s.refs, [found.id]: ref } }
  }
  return patch(s, found.id, r => ({
    ...r,
    mentions: r.mentions + 1,
    lastSeen: now,
    sources: r.sources.includes(source) ? r.sources : [...r.sources, source],
    score: source === 'manual' ? Math.max(r.score, MANUAL_MIN_SCORE) : r.score,
    untracked: r.untracked && source !== 'prompt' && source !== 'manual',
  }))
}

export const upsertBranch = (s: ContextState, found: Found, now: number): ContextState =>
  patch(upsertRef(s, found, 'branch', now), found.id, r => ({ ...r, score: 1 }))

export const setBranch = (s: ContextState, branch: string | undefined): ContextState => ({ ...s, branch })

export const applyCard = (s: ContextState, id: string, card: Card, fingerprint: string, now: number): ContextState =>
  patch(s, id, ({ error: _error, ...r }) => ({ ...r, card, fingerprint, fetchedAt: now }))

export const markError = (s: ContextState, id: string, error: string): ContextState => patch(s, id, r => ({ ...r, error }))

export const applyScores = (s: ContextState, scores: Record<string, { score: number; why: string }>, hash: string, now: number): ContextState => {
  const refs = { ...s.refs }
  for (const [id, v] of Object.entries(scores)) {
    const r = refs[id]
    if (r) refs[id] = { ...r, score: Math.max(v.score, scoreFloor(r)), why: v.why }
  }
  return { ...s, refs, lastCuratedSetHash: hash, lastCuratedAt: now }
}

export const untrack = (s: ContextState, id: string): ContextState => patch(s, id, r => ({ ...r, untracked: true }))

export const pin = (s: ContextState, id: string): ContextState => patch(s, id, r => ({ ...r, pinned: true }))

export const addNote = (s: ContextState, id: string, note: Note): ContextState => patch(s, id, r => ({ ...r, notes: [...r.notes, note] }))

export const touchPrompt = (s: ContextState, now: number): ContextState => ({ ...s, lastPromptAt: now, activity: 'active' })

export const setActivity = (s: ContextState, activity: Activity): ContextState => ({ ...s, activity })

const isManual = (r: Ref): boolean => r.sources.includes('manual')

export const MANUAL_MIN_SCORE = 0.7

export const scoreFloor = (r: Ref): number => (isManual(r) ? MANUAL_MIN_SCORE : 0)

const byRank = (a: Ref, b: Ref) => Number(b.pinned) - Number(a.pinned) || Number(isManual(b)) - Number(isManual(a)) || b.score - a.score || b.lastSeen - a.lastSeen

const tracked = (s: ContextState): Ref[] => Object.values(s.refs).filter(r => !r.untracked)

const PRIMARY_MIN_SCORE = 0.3

const canBePrimary = (r: Ref): boolean => r.pinned || r.sources.some(src => src !== 'tool') || r.score >= PRIMARY_MIN_SCORE

export const primary = (s: ContextState): { pr?: Ref; slack?: Ref; jira?: Ref; branch?: Ref } => {
  const best = (kind: Ref['kind']) => tracked(s).filter(r => r.kind === kind && canBePrimary(r)).sort(byRank)[0]
  const pr = best('github-pr')
  const slack = best('slack')
  const jira = best('jira')
  const branch = best('branch')
  return { ...(pr && { pr }), ...(slack && { slack }), ...(jira && { jira }), ...(branch && { branch }) }
}

export const also = (s: ContextState): Ref[] => {
  const chosen = new Set(Object.values(primary(s)).map(r => r.id))
  return tracked(s).filter(r => !chosen.has(r.id)).sort(byRank).slice(0, 6)
}

export const trackedIds = (s: ContextState): string[] => tracked(s).map(r => r.id)

export const setHash = (ids: string[]): string => [...ids].sort().join('|')
