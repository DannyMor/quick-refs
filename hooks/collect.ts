import { atom, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Source } from '../types'
import { extractRefs } from './refs'
import { EMPTY, STATE_SHAPE, setBranch, touchPrompt, upsertRef } from './store'

const state = atom({ plugin: 'context-pane', key: 'state' } as const, EMPTY, { shape: STATE_SHAPE })

const OWN_TOOLS = 'mcp__context-pane__'
const GITDIR = 'gitdir: '
const HEAD_REF = 'ref: refs/heads/'

export const projectsFrom = (options: { projects?: unknown }): string[] =>
  typeof options.projects === 'string' ? options.projects.split(',').map(p => p.trim()).filter(Boolean) : []

async function readText($: EngineInterface, path: string): Promise<string | undefined> {
  try {
    return await $.fs.read(path)
  } catch {
    return undefined
  }
}

export async function readBranch($: EngineInterface, cwd: string): Promise<string | undefined> {
  const dotGit = await readText($, `${cwd}/.git`)
  let gitDir = `${cwd}/.git`
  if (dotGit?.startsWith(GITDIR)) {
    const target = dotGit.slice(GITDIR.length).trim()
    gitDir = target.startsWith('/') ? target : `${cwd}/${target}`
  }
  const head = (await readText($, `${gitDir}/HEAD`))?.trim()
  return head?.startsWith(HEAD_REF) ? head.slice(HEAD_REF.length) : undefined
}

export async function collectText($: EngineInterface, text: string, source: Source, projects: readonly string[]): Promise<void> {
  const found = extractRefs(text, projects)
  if (found.length === 0) return
  const now = Date.now()
  await update($, state, s => found.reduce((acc, f) => upsertRef(acc, f, source, now), s))
}

export async function replay($: EngineInterface, projects: readonly string[]): Promise<void> {
  for (const m of await $.session.messages()) {
    await collectText($, m.text, m.role === 'user' ? 'prompt' : 'answer', projects)
    for (const use of m.toolUses) {
      await collectText($, JSON.stringify(use.input), 'tool', projects)
      if (use.text) await collectText($, use.text, 'tool', projects)
    }
  }
}

export async function onPromptSubmit($: EngineInterface, e: { text: string }, next: (e: any) => Promise<any>, projects: readonly string[]) {
  await update($, state, s => touchPrompt(s, Date.now())).catch(() => {})
  await collectText($, e.text, 'prompt', projects).catch(() => {})
  return next(e)
}

export async function onToolCallCollect($: EngineInterface, e: { tool: string; tool_use_id?: string }, next: (e: any) => Promise<any>, projects: readonly string[]) {
  const result = await next(e)
  if (e.tool.startsWith(OWN_TOOLS)) return result
  const { tool_use_id: _id, ...rest } = e
  await collectText($, JSON.stringify(rest), 'tool', projects).catch(() => {})
  if (typeof result?.text === 'string') await collectText($, result.text, 'tool', projects).catch(() => {})
  return result
}

export async function onTurnComplete($: EngineInterface, e: { answer: string; agentId?: string }, next: (e: any) => Promise<any>, projects: readonly string[]) {
  if (!e.agentId) await collectText($, e.answer, 'answer', projects)
  return next(e)
}

export async function startCollecting($: EngineInterface, cwd: string, projects: readonly string[]): Promise<void> {
  const branch = await readBranch($, cwd)
  await update($, state, s => setBranch(s, branch))
  if (branch) await collectText($, branch, 'branch', projects)
  await replay($, projects)
}
