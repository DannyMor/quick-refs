import { atom, read, update } from 'claude-code'
import type { EngineInterface, Timer } from 'claude-code'
import type { Activity, Card, ContextState, Ref, RefKind } from '../../types'
import { EMPTY, STATE_SHAPE, applyCard, markError, setActivity } from '../store'
import { fetchPrs, githubPoller, isProcessRefused, resetGithub } from './github'
import { fetchIssues, jiraPoller, resetJira } from './jira'
import { NotConnected } from './mcp'
import { fetchThreads, slackPoller, threadOf } from './slack'

const state = atom({ plugin: 'context-pane', key: 'state' } as const, EMPTY, { shape: STATE_SHAPE })

type Connector = 'atlassian' | 'slack'
type Lane = 'jira' | 'slack' | 'pr'

export type Fetched = { id: string; raw: unknown; error?: string }
export type FetchContext = { server: string; since?: number }
export type Poller = {
  kind: RefKind
  connector?: Connector
  fingerprint(raw: unknown): string
  toCard(raw: unknown): Card
}

export const SERVERS: Record<Connector, { probe: string; label: string; fallbacks: string[] }> = {
  atlassian: { probe: 'getJiraIssue', label: 'Atlassian', fallbacks: ['claude.ai Atlassian', 'claude_ai_Atlassian'] },
  slack: { probe: 'slack_read_thread', label: 'Slack', fallbacks: ['claude.ai Slack', 'claude_ai_Slack'] },
}

export const INTERVALS: Record<Exclude<Activity, 'idle'>, Record<Lane, number>> = {
  active: { jira: 900_000, slack: 180_000, pr: 300_000 },
  quiet: { jira: 1_800_000, slack: 1_200_000, pr: 1_200_000 },
}

const QUIET_AFTER = 30 * 60_000
const IDLE_AFTER = 2 * 3_600_000

const LANES: Array<[Lane, Poller]> = [['jira', jiraPoller], ['slack', slackPoller], ['pr', githubPoller]]
const POLLERS: Partial<Record<RefKind, Poller>> = { jira: jiraPoller, slack: slackPoller, 'github-pr': githubPoller }

const WRITE_TOOLS = ['__transitionJiraIssue', '__editJiraIssue', '__addOrEditJiraIssueComment', '__slack_send_message']
const GH_PR = /^\s*gh\s+pr\s/
const GH_PR_VIEW = /^\s*gh\s+pr\s+view\b/

const servers: Partial<Record<Connector, string>> = {}
const lastPolled: Partial<Record<RefKind, number>> = {}
const timers: Partial<Record<Lane, { handle: Timer; ms: number }>> = {}

export const activityFor = (lastPromptAt: number, now: number): Activity => {
  const quietFor = now - lastPromptAt
  return quietFor >= IDLE_AFTER ? 'idle' : quietFor >= QUIET_AFTER ? 'quiet' : 'active'
}

async function resolveServer($: EngineInterface, connector: Connector): Promise<string | undefined> {
  if (servers[connector]) return servers[connector]
  const suffix = `__${SERVERS[connector].probe}`
  const hit = (await $.tool.list()).find(t => t.name.startsWith('mcp__') && t.name.endsWith(suffix))
  if (hit) servers[connector] = hit.name.slice('mcp__'.length, -suffix.length)
  return servers[connector]
}

async function fetchByFallbackName($: EngineInterface, connector: Connector, kind: RefKind, refs: Ref[], since: number | undefined): Promise<Fetched[]> {
  for (const name of SERVERS[connector].fallbacks) {
    try {
      const fetched = await fetchFor($, kind, refs, { server: name, ...(since !== undefined && { since }) })
      servers[connector] = name
      return fetched
    } catch {
      continue
    }
  }
  throw new NotConnected()
}

async function fetchFor($: EngineInterface, kind: RefKind, refs: Ref[], ctx: FetchContext): Promise<Fetched[]> {
  if (kind === 'jira') return fetchIssues($, refs, ctx)
  if (kind === 'slack') return fetchThreads($, refs, ctx)
  if (kind === 'github-pr') return fetchPrs($, refs)
  return []
}

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err))

export async function pollKind($: EngineInterface, poller: Poller, opts: { ids?: string[]; isFull?: boolean } = {}): Promise<void> {
  const s = await read($, state)
  const refs = Object.values(s.refs).filter(r => r.kind === poller.kind && !r.untracked && (!opts.ids || opts.ids.includes(r.id)))
  if (refs.length === 0) return
  const polledAt = await $.clock.now()
  let fetched: Fetched[]
  try {
    const server = poller.connector ? await resolveServer($, poller.connector) : ''
    const since = opts.isFull ? undefined : lastPolled[poller.kind]
    fetched = poller.connector && !server
      ? await fetchByFallbackName($, poller.connector, poller.kind, refs, since)
      : await fetchFor($, poller.kind, refs, { server: server ?? '', ...(since !== undefined && { since }) })
    if (!opts.ids) lastPolled[poller.kind] = polledAt
  } catch (err) {
    const isGone = !!poller.connector && err instanceof NotConnected
    if (isGone && poller.connector) delete servers[poller.connector]
    const error = isGone && poller.connector ? `not connected: ${SERVERS[poller.connector].label}, run /mcp` : messageOf(err)
    fetched = refs.map(r => ({ id: r.id, raw: undefined, error }))
  }

  const changes: Array<(acc: ContextState) => ContextState> = []
  for (const f of fetched) {
    const ref = s.refs[f.id]
    if (!ref) continue
    let next: { card: Card; fingerprint: string } | { error: string }
    try {
      next = f.error !== undefined ? { error: f.error } : { card: poller.toCard(f.raw), fingerprint: poller.fingerprint(f.raw) }
    } catch (err) {
      next = { error: `unreadable result: ${messageOf(err)}` }
    }
    if ('error' in next) {
      const { error } = next
      if (ref.error !== error) changes.push(acc => (acc.refs[f.id]?.error === error ? acc : markError(acc, f.id, error)))
    } else if (ref.fingerprint !== next.fingerprint || ref.error !== undefined) {
      const { card, fingerprint } = next
      const seen = ref.fingerprint
      const now = Date.now()
      changes.push(acc => (acc.refs[f.id]?.fingerprint !== seen ? acc : applyCard(acc, f.id, card, fingerprint, now)))
    }
  }
  if (changes.length > 0) await update($, state, cur => changes.reduce((acc, change) => change(acc), cur))
}

export async function refreshOne($: EngineInterface, id: string): Promise<void> {
  const ref = (await read($, state)).refs[id]
  const poller = ref && POLLERS[ref.kind]
  if (poller) await pollKind($, poller, { ids: [id], isFull: true })
}

export async function refreshAll($: EngineInterface): Promise<void> {
  await Promise.all(LANES.map(([, poller]) => pollKind($, poller, { isFull: true }).catch(() => {})))
}

const isUnfetched = (r: Ref): boolean =>
  !r.untracked && r.fetchedAt === undefined && r.error === undefined && r.sources.some(src => src !== 'tool')

export async function pollUnfetched($: EngineInterface): Promise<void> {
  const refs = Object.values((await read($, state)).refs).filter(isUnfetched)
  await Promise.all(LANES.map(([, poller]) => {
    const ids = refs.filter(r => r.kind === poller.kind).map(r => r.id)
    return ids.length === 0 ? undefined : pollKind($, poller, { ids, isFull: true }).catch(() => {})
  }))
}

async function tick($: EngineInterface, lane: Lane, poller: Poller): Promise<void> {
  const s = await read($, state)
  const activity = activityFor(s.lastPromptAt, Date.now())
  if (activity !== s.activity) await update($, state, cur => setActivity(cur, activity))
  if (activity === 'idle') return
  const ms = INTERVALS[activity][lane]
  if (timers[lane]?.ms !== ms) arm($, lane, poller, ms)
  if (lane === 'pr' && isProcessRefused()) return
  await pollKind($, poller)
}

function arm($: EngineInterface, lane: Lane, poller: Poller, ms: number): void {
  timers[lane]?.handle.cancel()
  timers[lane] = { ms, handle: $.clock.every(ms, () => void tick($, lane, poller).catch(() => {})) }
}

const stopScheduler = (): void => {
  for (const [lane] of LANES) {
    timers[lane]?.handle.cancel()
    delete timers[lane]
  }
}

export function startScheduler($: EngineInterface): () => void {
  stopScheduler()
  for (const [lane, poller] of LANES) arm($, lane, poller, INTERVALS.active[lane])
  return stopScheduler
}

export function startPolling($: EngineInterface): void {
  for (const key of Object.keys(servers) as Connector[]) delete servers[key]
  for (const key of Object.keys(lastPolled) as RefKind[]) delete lastPolled[key]
  resetJira()
  resetGithub()
  startScheduler($)
  void refreshAll($)
}

const isObservedWrite = (e: { tool: string; command?: unknown }): boolean =>
  WRITE_TOOLS.some(suffix => e.tool.endsWith(suffix)) ||
  (e.tool === 'Bash' && typeof e.command === 'string' && GH_PR.test(e.command) && !GH_PR_VIEW.test(e.command))

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

const mentions = (ref: Ref, text: string): boolean => {
  if (text.includes(ref.href)) return true
  if (ref.kind === 'jira') return new RegExp(`\\b${escapeRe(ref.id)}\\b`).test(text)
  if (ref.kind === 'slack') {
    const thread = threadOf(ref.id)
    return !!thread && text.includes(thread.channel_id) && text.includes(thread.message_ts)
  }
  if (ref.kind === 'github-pr') {
    const [repo, n] = ref.id.split('#')
    return text.includes(ref.id) || (!!repo && !!n && text.includes(repo) && new RegExp(`\\b${n}\\b`).test(text))
  }
  return false
}

export async function onToolCallObserveWrites($: EngineInterface, e: { tool: string; tool_use_id?: string; command?: unknown }, next: (e: any) => Promise<any>) {
  const result = await next(e)
  if (!isObservedWrite(e)) return result
  try {
    const { tool_use_id: _id, ...rest } = e
    const text = JSON.stringify(rest)
    for (const ref of Object.values((await read($, state)).refs)) {
      if (!ref.untracked && mentions(ref, text)) void refreshOne($, ref.id).catch(() => {})
    }
  } catch {
    return result
  }
  return result
}

export async function onPromptSubmitPoll($: EngineInterface, e: unknown, next: (e: any) => Promise<any>) {
  const wasIdle = await read($, state).then(s => activityFor(s.lastPromptAt, Date.now()) === 'idle', () => false)
  const result = await next(e)
  if (wasIdle) void refreshAll($).catch(() => {})
  for (const [lane, poller] of LANES) {
    const armed = timers[lane]
    if (armed && armed.ms !== INTERVALS.active[lane]) arm($, lane, poller, INTERVALS.active[lane])
  }
  if (isProcessRefused()) void pollKind($, githubPoller).catch(() => {})
  return result
}

export async function onTurnCompletePoll($: EngineInterface, e: unknown, next: (e: any) => Promise<any>) {
  void pollUnfetched($).catch(() => {})
  return next(e)
}
