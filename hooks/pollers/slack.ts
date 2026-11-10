import type { EngineInterface } from 'claude-code'
import type { Card, Ref } from '../../types'
import type { Fetched, FetchContext, Poller } from './index'
import { callMcp } from './mcp'

type Message = { ts: string; author: string; text: string }
type Thread = { channel: string; messages: Message[]; prevTs?: string }

const PERMALINK = /\/archives\/([A-Z0-9]+)\/p(\d{7,})/
const SEAT = 6
const READ_LIMIT = 200
const TEXT_MAX = 200

export const threadOf = (url: string): { channel_id: string; message_ts: string } | undefined => {
  const m = PERMALINK.exec(url)
  if (!m?.[1] || !m[2]) return undefined
  return { channel_id: m[1], message_ts: `${m[2].slice(0, -SEAT)}.${m[2].slice(-SEAT)}` }
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '')

const BLOCK_START = /^(=== THREAD PARENT MESSAGE ===|--- Reply \d+ of \d+ ---)$/
const REPLIES_HEADER = /^=== THREAD REPLIES/
const SKIP_LINE = /^(Time|Reactions|Files): /

export const parseThreadText = (text: string): Message[] => {
  const messages: Message[] = []
  let current: Message | undefined
  for (const line of text.split('\n')) {
    if (BLOCK_START.test(line)) {
      current = { ts: '', author: '', text: '' }
      messages.push(current)
      continue
    }
    if (!current || REPLIES_HEADER.test(line) || SKIP_LINE.test(line)) continue
    if (line.startsWith('From: ')) {
      current.author = line.slice('From: '.length).split(/ [<(]/)[0]?.trim() ?? ''
      continue
    }
    if (line.startsWith('Message TS: ')) {
      current.ts = line.slice('Message TS: '.length).trim()
      continue
    }
    current.text = current.text ? `${current.text}\n${line}` : line
  }
  return messages.filter(m => m.ts !== '').map(m => ({ ...m, text: m.text.trim() }))
}

const messagesOf = (value: unknown): Message[] | undefined => {
  const raw = (value as { messages?: unknown })?.messages
  return typeof raw === 'string' ? parseThreadText(raw) : undefined
}

const channelNameOf = (value: unknown): string | undefined => {
  const v = value as { channel?: { name?: unknown } | unknown; channel_name?: unknown } | undefined
  const nested = typeof v?.channel === 'object' && v.channel ? (v.channel as { name?: unknown }).name : undefined
  return str(nested) || str(v?.channel_name) || undefined
}

export async function fetchThreads($: EngineInterface, refs: Ref[], ctx: FetchContext): Promise<Fetched[]> {
  const out: Fetched[] = []
  for (const ref of refs) {
    const thread = threadOf(ref.id)
    if (!thread) {
      out.push({ id: ref.id, raw: undefined, error: 'not a thread permalink' })
      continue
    }
    const res = await callMcp($, ctx.server, 'slack_read_thread', { ...thread, limit: READ_LIMIT })
    if (res.error !== undefined) {
      out.push({ id: ref.id, raw: undefined, error: res.error })
      continue
    }
    const messages = messagesOf(res.value)
    if (!messages?.length) {
      out.push({ id: ref.id, raw: undefined, error: 'unreadable slack_read_thread result' })
      continue
    }
    const prevTs = ref.fingerprint?.split(':')[0]
    const raw: Thread = { channel: channelNameOf(res.value) ?? thread.channel_id, messages, ...(prevTs && { prevTs }) }
    out.push({ id: ref.id, raw })
  }
  return out
}

const fingerprint = (raw: unknown): string => {
  const { messages } = raw as Thread
  return `${messages.at(-1)?.ts ?? ''}:${messages.length - 1}`
}

const toCard = (raw: unknown): Card => {
  const { channel, messages, prevTs } = raw as Thread
  const last = messages.at(-1)
  return {
    kind: 'slack',
    channel,
    replyCount: messages.length - 1,
    participants: [...new Set(messages.map(m => m.author).filter(Boolean))],
    latest: { author: last?.author ?? '', age: last?.ts ?? '', text: (last?.text ?? '').slice(0, TEXT_MAX) },
    newSince: prevTs === undefined ? 0 : messages.filter(m => Number(m.ts) > Number(prevTs)).length,
  }
}

export const slackPoller: Poller = { kind: 'slack', connector: 'slack', fingerprint, toCard }
