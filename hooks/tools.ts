import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import { extractRefs } from './refs'
import { refreshAll, refreshOne } from './pollers/index'
import { EMPTY, STATE_SHAPE, addNote, pin, untrack, upsertRef } from './store'

const state = atom({ plugin: 'context-pane', key: 'state' } as const, EMPTY, { shape: STATE_SHAPE })
const closedByPerson = atom({ plugin: 'context-pane', key: 'isClosedByPerson' } as const, false, { shape: 'closed-1' })

export const PANE = 'context'
export const TOOL_PREFIX = 'mcp__context-pane__'

const refSchema = { type: 'object', properties: { ref: { type: 'string', description: 'Jira key, Slack permalink, PR url or the id shown in the pane' } }, required: ['ref'] }

async function resolveId($: EngineInterface, input: string, projects: readonly string[]): Promise<string | undefined> {
  const text = input.trim()
  if ((await read($, state)).refs[text]) return text
  return extractRefs(text, projects)[0]?.id
}

const reply = (text: string) => ({ result: { content: [{ type: 'text', text }] }, text })

export async function registerTools($: EngineInterface): Promise<void> {
  await $.tool.register({
    name: 'note',
    description: 'Attach a short note to a tracked reference in the context pane. Call it after reading a Slack thread to record the decision or the action item it holds.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Id of a tracked reference' },
        text: { type: 'string', description: 'The note, one short line' },
        kind: { type: 'string', enum: ['action', 'fact'] },
        done: { type: 'boolean', description: 'True when the action is already done' },
      },
      required: ['ref', 'text', 'kind'],
    },
    isDeferred: false,
  })
  await $.tool.register({
    name: 'pin',
    description: 'Pin a reference as the primary one in the context pane. Call it when the user says this is the one.',
    inputSchema: refSchema,
    isDeferred: false,
  })
  await $.tool.register({
    name: 'track',
    description: 'Start tracking a Jira key, Slack permalink or PR url in the context pane.',
    inputSchema: refSchema,
  })
  await $.tool.register({
    name: 'untrack',
    description: 'Hide a reference from the context pane. Call it when the user says it is irrelevant.',
    inputSchema: refSchema,
  })
  await $.tool.register({
    name: 'refresh',
    description: 'Refresh the cards in the context pane now, one reference or all of them.',
    inputSchema: { type: 'object', properties: { ref: { type: 'string', description: 'Reference to refresh; all when left out' } } },
  })
  await $.command.register({ name: 'context-pane', description: 'Open the context pane' })
  await $.command.register({ name: 'track', description: 'Track a Jira key, Slack permalink or PR url', argumentHint: '<ref>' })
  await $.command.register({ name: 'untrack', description: 'Hide a reference from the context pane', argumentHint: '<ref>' })
}

async function trackText($: EngineInterface, input: string, projects: readonly string[]): Promise<string> {
  const found = extractRefs(input.trim(), projects)[0]
  if (found) {
    await update($, state, s => upsertRef(s, found, 'manual', Date.now()))
    await refreshOne($, found.id).catch(() => {})
    return `tracking ${found.id}`
  }
  const id = await resolveId($, input, projects)
  if (!id) return `could not find a Jira key, Slack link or PR url in "${input.trim()}"`
  await update($, state, s => upsertRef(s, { id, kind: s.refs[id]!.kind, href: s.refs[id]!.href, snippet: s.refs[id]!.snippet }, 'manual', Date.now()))
  await refreshOne($, id).catch(() => {})
  return `tracking ${id}`
}

async function untrackText($: EngineInterface, input: string, projects: readonly string[]): Promise<string> {
  const id = await resolveId($, input, projects)
  if (!id) return `${input.trim()} is not tracked`
  await update($, state, s => untrack(s, id))
  return `untracked ${id}`
}

export async function onTrackTool($: EngineInterface, e: { ref: string }, projects: readonly string[]) {
  return reply(await trackText($, e.ref, projects))
}

export async function onUntrackTool($: EngineInterface, e: { ref: string }, projects: readonly string[]) {
  return reply(await untrackText($, e.ref, projects))
}

export async function onPinTool($: EngineInterface, e: { ref: string }, projects: readonly string[]) {
  const id = await resolveId($, e.ref, projects)
  if (!id || !(await read($, state)).refs[id]) return reply(`${e.ref} is not tracked`)
  await update($, state, s => pin(s, id))
  return reply(`pinned ${id}`)
}

export async function onRefreshTool($: EngineInterface, e: { ref?: string }, projects: readonly string[]) {
  if (!e.ref) {
    await refreshAll($)
    return reply('refreshed all')
  }
  const id = await resolveId($, e.ref, projects)
  if (!id || !(await read($, state)).refs[id]) return reply(`${e.ref} is not tracked`)
  try {
    await refreshOne($, id)
  } catch (error) {
    return reply(`refresh failed for ${id}: ${error instanceof Error ? error.message : String(error)}`)
  }
  return reply(`refreshed ${id}`)
}

export async function onNoteTool($: EngineInterface, e: { ref: string; text: string; kind: 'action' | 'fact'; done?: boolean }, projects: readonly string[]) {
  const id = await resolveId($, e.ref, projects)
  if (!id || !(await read($, state)).refs[id]) return reply(`${e.ref} is not tracked`)
  await update($, state, s => addNote(s, id, { text: e.text, kind: e.kind, done: e.done ?? false, at: Date.now() }))
  return reply(`noted on ${id}`)
}

export async function onTrackCommand($: EngineInterface, e: { args: string }, projects: readonly string[]) {
  return { text: await trackText($, e.args, projects) }
}

export async function onUntrackCommand($: EngineInterface, e: { args: string }, projects: readonly string[]) {
  return { text: await untrackText($, e.args, projects) }
}

export async function onContextPaneCommand($: EngineInterface) {
  await update($, closedByPerson, () => false)
  await $.ui.open({ id: PANE, title: 'Context' })
  return { text: 'Context pane opened.' }
}

export async function onPaneClose($: EngineInterface, e: { id: string; origin: { kind: string } }, next: (e: any) => Promise<any>) {
  if (e.id === PANE && e.origin.kind === 'person') await update($, closedByPerson, () => true)
  return next(e)
}
