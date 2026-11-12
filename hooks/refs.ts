import type { Found } from '../types'

const SLACK_RE = /(https:\/\/[\w-]+\.slack\.com\/archives\/[A-Z0-9]+\/p)\d+(?:\?[^\s]*?\bthread_ts=(\d+)\.(\d+))?/
const PR_RE = /https:\/\/github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+)/
const SNIPPET_MAX = 200

let site = ''

export const setJiraSite = (value: string): void => {
  site = value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '')
}

export const jiraSite = (): string => site

export const jiraHref = (key: string): string => (site ? `https://${site}/browse/${key}` : '#')

export const prIdFromUrl = (url: string): string => {
  const m = PR_RE.exec(url)
  if (!m) throw new Error(`not a pull request url: ${url}`)
  return `${m[1]}/${m[2]}#${m[3]}`
}

export const prUrl = (id: string): string => {
  const m = /^([^/]+)\/([^#]+)#(\d+)$/.exec(id)
  if (!m) throw new Error(`not a pull request id: ${id}`)
  return `https://github.com/${m[1]}/${m[2]}/pull/${m[3]}`
}

const slackIdOf = (m: RegExpExecArray | RegExpMatchArray): string => {
  const [whole, base, seconds, micros] = m
  return seconds && micros ? `${base}${seconds}${micros}` : whole
}

export const slackIdFromUrl = (url: string): string => {
  const m = SLACK_RE.exec(url)
  if (!m) throw new Error(`not a slack permalink: ${url}`)
  return slackIdOf(m)
}

const isBoundary = (ch: string | undefined): boolean =>
  ch === '.' || ch === '!' || ch === '?' || ch === '\n'

const snippetAround = (text: string, start: number, end: number): string => {
  let from = start
  while (from > 0 && !isBoundary(text[from - 1])) from--
  let to = end
  while (to < text.length && !isBoundary(text[to])) to++
  const sentence = text.slice(from, to).trim()
  if (sentence.length <= SNIPPET_MAX) return sentence
  const hitStart = Math.max(0, start - from)
  const hitLen = end - start
  const slack = Math.max(0, SNIPPET_MAX - hitLen)
  const winStart = Math.min(Math.max(0, hitStart - Math.floor(slack / 2)), sentence.length - SNIPPET_MAX)
  return sentence.slice(winStart, winStart + SNIPPET_MAX)
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

export const extractRefs = (text: string, projects: readonly string[]): Found[] => {
  const hits: Array<Found & { index: number }> = []
  const add = (index: number, length: number, id: string, kind: Found['kind'], href: string): void => {
    hits.push({ id, kind, href, snippet: snippetAround(text, index, index + length), index })
  }

  if (projects.length > 0) {
    const jira = new RegExp(`\\b(?:${projects.map(escapeRe).join('|')})-\\d+\\b`, 'g')
    for (const m of text.matchAll(jira)) add(m.index, m[0].length, m[0], 'jira', jiraHref(m[0]))
  }
  for (const m of text.matchAll(new RegExp(SLACK_RE, 'g'))) {
    const id = slackIdOf(m)
    add(m.index, m[0].length, id, 'slack', id)
  }
  for (const m of text.matchAll(new RegExp(PR_RE, 'g'))) {
    const id = prIdFromUrl(m[0])
    add(m.index, m[0].length, id, 'github-pr', prUrl(id))
  }

  hits.sort((a, b) => a.index - b.index)
  const seen = new Set<string>()
  const found: Found[] = []
  for (const { index: _index, ...hit } of hits) {
    if (seen.has(hit.id)) continue
    seen.add(hit.id)
    found.push(hit)
  }
  return found
}
