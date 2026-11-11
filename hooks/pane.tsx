import { atom, read } from 'claude-code'
import type { EngineInterface, RenderInput } from 'claude-code'
import type { Card, ContextState, Ref, RefKind } from '../types'
import { EMPTY, STATE_SHAPE, also, primary } from './store'

export type Tone = 'ok' | 'warn' | 'bad' | 'merged' | 'muted' | 'plain'

export type Row = {
  key: string
  icon: string
  href: string
  link: string
  info: string
  status: string
  tone: Tone
  dim: boolean
  group: 'primary' | 'also'
}

const state = atom({ plugin: 'quick-refs', key: 'state' } as const, EMPTY, { shape: STATE_SHAPE })

const SUBTASK_ROWS = 5
const LINK_COLUMNS = 28
const STATUS_COLUMNS = 9
export const FOCUS_TITLE = 'Session Focus'
export const ALSO_TITLE = 'Also Referenced'
const SHORT_STATUS: Record<string, string> = { 'in progress': 'In Prog', 'selected for development': 'Selected', 'code review': 'Review' }
const DIM_BELOW = 0.3

const TONE_COLOR: Partial<Record<Tone, string>> = { ok: '#3fb950', bad: '#f85149', warn: '#d29922', merged: '#a371f7' }

const GLYPH: Record<RefKind, string> = { branch: '⎇', jira: '🎫', slack: '💬', 'github-pr': '🐙' }

const svg = (body: string) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16" width="14" height="14">${body}</svg>`

const SVG: Record<RefKind, string> = {
  branch: svg('<g fill="none" stroke="#8b949e" stroke-width="1.5"><circle cx="4" cy="3" r="1.6"/><circle cx="4" cy="13" r="1.6"/><circle cx="12" cy="5" r="1.6"/><path d="M4 4.6v6.8M12 6.6c0 3-8 2-8 4.8"/></g>'),
  jira: svg('<path d="M8 1l7 7-7 7-7-7z" fill="#2684ff"/><path d="M8 5l3 3-3 3-3-3z" fill="#ffffff"/>'),
  slack: svg('<rect x="2" y="6" width="12" height="2.4" rx="1.2" fill="#36c5f0"/><rect x="7.6" y="2" width="2.4" height="12" rx="1.2" fill="#2eb67d"/><rect x="2" y="9.6" width="12" height="2.4" rx="1.2" fill="#ecb22e"/><rect x="4" y="2" width="2.4" height="12" rx="1.2" fill="#e01e5a"/>'),
  'github-pr': svg('<g fill="none" stroke="#8b949e" stroke-width="1.5"><circle cx="4" cy="3" r="1.6"/><circle cx="4" cy="13" r="1.6"/><circle cx="12" cy="13" r="1.6"/><path d="M4 4.6v6.8M4 4.6c0 4 8 2 8 6.8"/></g>'),
}

export const toneOf = (word: string): Tone => {
  const w = word.toLowerCase()
  if (w === 'merged') return 'merged'
  if (w === 'done') return 'ok'
  if (w === 'blocked' || w === 'error') return 'bad'
  if (w === 'in progress' || w === 'code review' || w === 'review') return 'warn'
  if (w === "won't do" || w === 'stale' || w === 'cancelled' || w === 'canceled') return 'muted'
  return 'plain'
}

const CHECK_GLYPH = { pass: '✓', fail: '✗', pending: '…', none: '' } as const
const CHECK_TONE = { pass: 'ok', fail: 'bad', pending: 'warn', none: 'plain' } as const

const prStatus = (card: Extract<Card, { kind: 'github-pr' }>): { status: string; tone: Tone } => {
  const glyph = CHECK_GLYPH[card.checks]
  const status = glyph ? `${card.state} ${glyph}` : card.state
  return { status, tone: card.state === 'open' ? CHECK_TONE[card.checks] : toneOf(card.state) }
}

const linkText = (r: Ref): string => {
  if (r.card?.kind === 'slack') return r.card.channel.startsWith('#') ? r.card.channel : `#${r.card.channel}`
  if (r.kind === 'github-pr') return `PR #${r.id.slice(r.id.lastIndexOf('#') + 1)}`
  if (r.kind === 'slack') return `#${r.id.split('/archives/')[1]?.split('/')[0] ?? 'slack'}`
  return r.id
}

const cardInfo = (card: Card | undefined): string | undefined => {
  if (!card) return undefined
  if (card.kind === 'jira') return card.summary
  if (card.kind === 'slack') return `${card.latest.author}: ${card.latest.text}`
  return card.title
}

const cardStatus = (card: Card | undefined): { status: string; tone: Tone } => {
  if (!card) return { status: '', tone: 'plain' }
  if (card.kind === 'jira') return { status: SHORT_STATUS[card.status.toLowerCase()] ?? card.status, tone: toneOf(card.status) }
  if (card.kind === 'slack') return { status: card.newSince > 0 ? `${card.newSince} new` : `${card.replyCount} msgs`, tone: 'plain' }
  return prStatus(card)
}

const refRow = (r: Ref, group: Row['group']): Row => {
  const { status, tone } = r.error ? (r.card ? { status: 'stale', tone: 'muted' as const } : { status: 'error', tone: 'bad' as const }) : cardStatus(r.card)
  const fallback = r.kind === 'branch' ? '' : r.snippet
  const action = r.notes.findLast(n => n.kind === 'action' && !n.done)
  const summary = group === 'also' ? r.why || cardInfo(r.card) || fallback : cardInfo(r.card) ?? fallback
  const info = action ? `□ ${action.text}` : summary
  return { key: r.id, icon: GLYPH[r.kind], href: r.href, link: linkText(r), info, status, tone, dim: r.score < DIM_BELOW, group }
}

const subtaskGlyph = (status: string): string => {
  const tone = toneOf(status)
  return tone === 'ok' ? '✓' : tone === 'bad' ? '⛔' : '○'
}

const subtaskRows = (jira: Ref): Row[] => {
  if (jira.card?.kind !== 'jira') return []
  const base = jira.href.slice(0, jira.href.length - jira.id.length)
  const subs = jira.card.subtasks
  const rows: Row[] = subs.slice(0, SUBTASK_ROWS).map(sub => ({
    key: `${jira.id}/${sub.key}`, icon: '', href: base + sub.key, link: `↳ ${sub.key}`, info: sub.title ?? '',
    status: `${subtaskGlyph(sub.status)} ${sub.status}`, tone: toneOf(sub.status), dim: false, group: 'primary',
  }))
  const rest = subs.length - SUBTASK_ROWS
  if (rest > 0) {
    rows.push({ key: `${jira.id}/+${rest}`, icon: '', href: jira.href, link: `↳ +${rest}`, info: '', status: '', tone: 'plain', dim: false, group: 'primary' })
  }
  return rows
}

const fit = (text: string, columns: number): string => {
  const chars = [...text]
  return chars.length <= columns ? text : `${chars.slice(0, columns - 1).join('')}…`
}

export const rowsFor = (s: ContextState): Row[] => {
  const p = primary(s)
  const rows: Row[] = []
  if (p.pr) rows.push(refRow(p.pr, 'primary'))
  if (p.slack) rows.push(refRow(p.slack, 'primary'))
  if (p.jira) rows.push(refRow(p.jira, 'primary'), ...subtaskRows(p.jira))
  if (p.branch) rows.push(refRow(p.branch, 'primary'))
  return [...rows, ...also(s).map(r => refRow(r, 'also'))].map(r => ({ ...r, link: fit(r.link, LINK_COLUMNS), status: fit(r.status, STATUS_COLUMNS) }))
}

export const age = (ms: number): string => {
  const sec = Math.max(0, Math.floor(ms / 1000))
  if (sec < 60) return `${sec}s ago`
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`
  return `${Math.floor(sec / 86400)}d ago`
}

export const footerFor = (s: ContextState, now: number): string => {
  const refs = Object.values(s.refs)
  const notConnected = refs.find(r => r.error?.startsWith('not connected:'))?.error
  if (notConnected) return notConnected
  const fetched = Math.max(0, ...refs.map(r => r.fetchedAt ?? 0))
  const parts = [
    `updated ${fetched > 0 ? age(now - fetched) : 'never'}`,
    `curated ${s.lastCuratedAt ? age(now - s.lastCuratedAt) : 'never'}`,
  ]
  if (s.activity === 'idle') parts.push('paused')
  return parts.join(' · ')
}

const TAG: Record<Tone, { color: string; background: string }> = {
  ok: { color: '#3fb950', background: 'rgba(63, 185, 80, 0.15)' },
  warn: { color: '#d29922', background: 'rgba(210, 153, 34, 0.16)' },
  bad: { color: '#f85149', background: 'rgba(248, 81, 73, 0.15)' },
  merged: { color: '#a371f7', background: 'rgba(163, 113, 247, 0.16)' },
  muted: { color: '#8b949e', background: 'rgba(139, 148, 158, 0.14)' },
  plain: { color: '#8b949e', background: 'rgba(139, 148, 158, 0.14)' },
}
const ROW_HOVER = 'rgba(127, 127, 127, 0.10)'
const PANE_BACKGROUND = 'rgba(127, 127, 127, 0.07)'
const FOCUS_CARD = { backgroundColor: 'rgba(56, 139, 253, 0.08)', borderColor: 'rgba(56, 139, 253, 0.35)', title: '#388bfd' }
const ALSO_CARD = { backgroundColor: 'rgba(110, 125, 150, 0.10)', borderColor: 'rgba(110, 125, 150, 0.30)' }
const ICON_COLUMNS = 2
const STATUS_BOX = STATUS_COLUMNS + 1

export const linkColumnsFor = (rows: readonly Row[]): number =>
  Math.min(LINK_COLUMNS, Math.max(4, ...rows.map(r => [...r.link].length)))

export const renderPane = async ($: EngineInterface, e: RenderInput<'Pane'>) => {
  const ui = $.ui.resolve(e)
  const { Box, Text, Link } = ui
  const Svg = e.surface === 'desktop' && 'Svg' in ui ? ui.Svg : undefined
  const isDesktop = Svg !== undefined
  const s = await read($, state)
  const rows = rowsFor(s)
  if (rows.length === 0) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Text dimColor>no references yet</Text>
      </Box>
    )
  }

  const linkColumns = linkColumnsFor(rows)
  const kindOf = (row: Row): RefKind | undefined => s.refs[row.key]?.kind
  const isSubtask = (row: Row): boolean => row.icon === '' && row.key.includes('/')
  const linkLabel = (row: Row): string => (isSubtask(row) ? row.link.replace(/^↳ /, '') : row.link)

  const icon = (row: Row) => {
    const kind = kindOf(row)
    if (isSubtask(row)) return <Text dimColor>↳</Text>
    return Svg && kind ? <Svg source={SVG[kind]} alt={kind} width={14} height={14} /> : <Text>{row.icon}</Text>
  }

  const status = (row: Row) => {
    if (!row.status) return undefined
    if (!isDesktop) return <Text color={TONE_COLOR[row.tone]} dimColor={!TONE_COLOR[row.tone]}>{row.status}</Text>
    const tag = TAG[row.tone]
    return (
      <Box backgroundColor={tag.background} paddingX={1}>
        <Text color={tag.color} size="caption" weight="medium">{row.status}</Text>
      </Box>
    )
  }

  const line = (row: Row) => (
    <Box key={row.key} flexDirection="column" paddingX={isDesktop ? 'xs' : 0} paddingY={isDesktop ? 'xs' : 0} {...(isDesktop && { hover: { backgroundColor: ROW_HOVER } })}>
      <Box flexDirection="row" alignItems="center" columnGap={1}>
        <Box width={ICON_COLUMNS} flexShrink={0}>
          {icon(row)}
        </Box>
        <Box width={linkColumns} flexShrink={0} overflow="hidden">
          <Link href={row.href} label={linkLabel(row)}>
            <Text mono={isDesktop} wrap="truncate-end">{linkLabel(row)}</Text>
          </Link>
        </Box>
        <Box flexGrow={1} flexShrink={1} minWidth={0} overflow="hidden">
          <Text dimColor={row.dim || isDesktop} size="footnote" wrap="truncate-end">{row.info}</Text>
        </Box>
        <Box width={STATUS_BOX} flexShrink={0} overflow="hidden" flexDirection="row">
          {status(row)}
        </Box>
      </Box>
      {isDesktop && row.info !== '' && (
        <Box display="none" hover={{ display: 'flex' }} paddingLeft={ICON_COLUMNS + linkColumns + 2} paddingRight={STATUS_BOX + 1} paddingTop="xs">
          <Text size="footnote" wrap="wrap">{row.info}</Text>
        </Box>
      )}
    </Box>
  )

  const primaryRows = rows.filter(r => r.group === 'primary')
  const alsoRows = rows.filter(r => r.group === 'also')
  const card = (look: { backgroundColor: string; borderColor: string }) =>
    isDesktop ? { borderStyle: 'round', borderColor: look.borderColor, backgroundColor: look.backgroundColor, padding: 'xs' as const } : {}
  const title = (text: string, color?: string) => (
    <Box paddingX={isDesktop ? 'xs' : 0} paddingY={isDesktop ? 'xs' : 0}>
      <Text bold weight="bold" {...(isDesktop && color && { color })}>{text}</Text>
    </Box>
  )

  return (
    <Box
      flexDirection="column" flexGrow={1} paddingX={1} paddingY={isDesktop ? 'sm' : 0} rowGap={isDesktop ? 'md' : 1}
      {...(isDesktop && { backgroundColor: PANE_BACKGROUND, minHeight: '100%' })}
    >
      {primaryRows.length > 0 && (
        <Box flexDirection="column" {...card(FOCUS_CARD)}>
          {title(FOCUS_TITLE, FOCUS_CARD.title)}
          {primaryRows.map(line)}
        </Box>
      )}
      {alsoRows.length > 0 && (
        <Box flexDirection="column" {...card(ALSO_CARD)}>
          {title(ALSO_TITLE)}
          {alsoRows.map(line)}
        </Box>
      )}
      <Box paddingX={isDesktop ? 'xs' : 0}>
        <Text dimColor size="caption" wrap="truncate-end">{footerFor(s, Date.now())}</Text>
      </Box>
    </Box>
  )
}
