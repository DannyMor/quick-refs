import type { EngineInterface } from 'claude-code'
import type { Card, Ref } from '../../types'
import type { Fetched, Poller } from './index'
import { firstLine } from './mcp'

type Check = { status?: string; conclusion?: string; state?: string }
type Pr = { number: number; state: string; title: string; updatedAt: string; reviewDecision?: string; statusCheckRollup?: Check[] }

const PR_ID = /^([^#]+)#(\d+)$/
const FIELDS = 'state,title,updatedAt,statusCheckRollup,reviewDecision'
const REFUSED = /refus|denied|unavailable|not available|cli only/i
const FAILED = new Set(['FAILURE', 'ERROR', 'CANCELLED', 'TIMED_OUT', 'ACTION_REQUIRED', 'STARTUP_FAILURE'])
const PENDING = new Set(['PENDING', 'EXPECTED', 'QUEUED', 'IN_PROGRESS', 'WAITING', 'REQUESTED'])

let processRefused = false

export const isProcessRefused = (): boolean => processRefused

export const resetGithub = (): void => {
  processRefused = false
}

export async function fetchPrs($: EngineInterface, refs: Ref[]): Promise<Fetched[]> {
  const out: Fetched[] = []
  for (const ref of refs) {
    const m = PR_ID.exec(ref.id)
    if (!m?.[1] || !m[2]) {
      out.push({ id: ref.id, raw: undefined, error: 'not a pull request id' })
      continue
    }
    let run
    try {
      run = await $.process.run(['gh', 'pr', 'view', m[2], '--repo', m[1], '--json', FIELDS])
    } catch (err) {
      const message = firstLine(err instanceof Error ? err.message : String(err))
      if (REFUSED.test(message)) {
        processRefused = true
        throw new Error(`gh refused: ${message}`)
      }
      out.push({ id: ref.id, raw: undefined, error: message })
      continue
    }
    if (run.exitCode !== 0) {
      out.push({ id: ref.id, raw: undefined, error: firstLine(run.stderr) || `gh exited ${run.exitCode}` })
      continue
    }
    try {
      out.push({ id: ref.id, raw: { ...JSON.parse(run.stdout), number: Number(m[2]) } })
    } catch {
      out.push({ id: ref.id, raw: undefined, error: 'unreadable gh output' })
    }
  }
  return out
}

const checksOf = (rollup: Check[] = []): Extract<Card, { kind: 'github-pr' }>['checks'] => {
  if (rollup.length === 0) return 'none'
  const outcomes = rollup.map(c => (c.conclusion || c.state || c.status || '').toUpperCase())
  if (outcomes.some(o => FAILED.has(o))) return 'fail'
  if (outcomes.some(o => o === '' || PENDING.has(o))) return 'pending'
  return 'pass'
}

const stateOf = (state: string): 'open' | 'merged' | 'closed' => {
  const s = state.toLowerCase()
  return s === 'merged' || s === 'closed' ? s : 'open'
}

const fingerprint = (raw: unknown): string => {
  const pr = raw as Pr
  return [pr.updatedAt, pr.state, checksOf(pr.statusCheckRollup), pr.reviewDecision ?? ''].join('|')
}

const toCard = (raw: unknown): Card => {
  const pr = raw as Pr
  return {
    kind: 'github-pr', number: pr.number, title: pr.title, state: stateOf(pr.state),
    checks: checksOf(pr.statusCheckRollup), reviewDecision: pr.reviewDecision ?? '',
  }
}

export const githubPoller: Poller = { kind: 'github-pr', fingerprint, toCard }
