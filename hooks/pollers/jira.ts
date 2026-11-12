import type { EngineInterface } from 'claude-code'
import type { Card, Ref } from '../../types'
import { jiraSite } from '../refs'
import type { Fetched, FetchContext, Poller } from './index'
import { callMcp } from './mcp'

type Named = { name?: string; displayName?: string }
type Issue = {
  key: string
  fields: {
    summary?: string
    status?: Named
    assignee?: Named | null
    updated?: string
    issuelinks?: Array<{ type?: Named; inwardIssue?: { key: string } }>
    subtasks?: Array<{ key: string; fields?: { summary?: string; status?: Named } }>
    comment?: { comments?: Array<{ author?: Named; created?: string; body?: unknown }> }
  }
}

const ISSUE_FIELDS = ['summary', 'status', 'assignee', 'updated', 'subtasks', 'issuelinks', 'comment']
const TEXT_MAX = 200
const MINUTE = 60_000

let cloudId: string | undefined

export const resetJira = (): void => {
  cloudId = undefined
}

const issueNodes = (value: unknown): Issue[] => {
  const issues = (value as { issues?: Issue[] | { nodes?: Issue[] } } | undefined)?.issues
  if (Array.isArray(issues)) return issues
  return issues?.nodes ?? []
}

const asIssue = (value: unknown): Issue | undefined => {
  const v = value as { fields?: unknown; issue?: { fields?: unknown } } | undefined
  if (v?.fields) return v as Issue
  if (v?.issue?.fields) return v.issue as Issue
  const first = issueNodes(value)[0]
  return first?.fields ? first : undefined
}

const firstSiteId = (value: unknown): string | undefined => {
  const v = value as { resources?: unknown; data?: { resources?: unknown } } | undefined
  const list = Array.isArray(value) ? value : (v?.data?.resources ?? v?.resources)
  const site = Array.isArray(list) ? list[0] : undefined
  const id = site?.cloudId ?? site?.id
  return typeof id === 'string' ? id : undefined
}

async function cloudIdFor($: EngineInterface, server: string): Promise<string> {
  if (cloudId) return cloudId
  const res = await callMcp($, server, 'getAccessibleAtlassianResources', {})
  if (res.error !== undefined) throw new Error(res.error)
  const id = firstSiteId(res.value) ?? jiraSite()
  if (!id) throw new Error('no Atlassian site found')
  cloudId = id
  return cloudId
}

async function changedKeys($: EngineInterface, server: string, cloud: string, refs: Ref[], since: number): Promise<string[]> {
  const isKnown = (r: Ref): boolean => r.fingerprint !== undefined && r.error === undefined
  const known = refs.filter(isKnown)
  const fresh = refs.filter(r => !isKnown(r)).map(r => r.id)
  if (known.length === 0) return fresh
  const minutes = Math.ceil(((await $.clock.now()) - since) / MINUTE) + 1
  const jql = `key in (${known.map(r => r.id).join(', ')}) AND updated >= "-${minutes}m"`
  const res = await callMcp($, server, 'searchJiraIssuesUsingJql', { cloudId: cloud, jql, fields: ['updated'], maxResults: 100 })
  if (res.error !== undefined) return refs.map(r => r.id)
  const hits = issueNodes(res.value).filter(i => known.find(r => r.id === i.key)?.fingerprint !== i.fields?.updated).map(i => i.key)
  return [...fresh, ...hits]
}

export async function fetchIssues($: EngineInterface, refs: Ref[], ctx: FetchContext): Promise<Fetched[]> {
  const cloud = await cloudIdFor($, ctx.server)
  const keys = ctx.since === undefined ? refs.map(r => r.id) : await changedKeys($, ctx.server, cloud, refs, ctx.since)
  const out: Fetched[] = []
  for (const key of keys) {
    const res = await callMcp($, ctx.server, 'getJiraIssue', { cloudId: cloud, issueIdOrKey: key, fields: ISSUE_FIELDS, view: 'full' })
    if (res.error !== undefined) {
      out.push({ id: key, raw: undefined, error: res.error })
      continue
    }
    const issue = asIssue(res.value)
    out.push(issue ? { id: key, raw: issue } : { id: key, raw: undefined, error: 'unreadable getJiraIssue result' })
  }
  return out
}

const fingerprint = (raw: unknown): string => (raw as Issue).fields.updated ?? ''

const toCard = (raw: unknown): Card => {
  const f = (raw as Issue).fields
  const last = f.comment?.comments?.at(-1)
  return {
    kind: 'jira',
    summary: f.summary ?? '',
    status: f.status?.name ?? '',
    assignee: f.assignee?.displayName ?? '',
    blockers: (f.issuelinks ?? []).filter(l => l.type?.name === 'Blocks' && l.inwardIssue).map(l => l.inwardIssue!.key),
    subtasks: (f.subtasks ?? []).map(t => ({ key: t.key, status: t.fields?.status?.name ?? '', ...(t.fields?.summary && { title: t.fields.summary }) })),
    ...(last && {
      lastComment: { author: last.author?.displayName ?? '', age: last.created ?? '', text: typeof last.body === 'string' ? last.body.slice(0, TEXT_MAX) : '' },
    }),
  }
}

export const jiraPoller: Poller = { kind: 'jira', connector: 'atlassian', fingerprint, toCard }
