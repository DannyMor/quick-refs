import { atom, read, update } from 'claude-code'
import type { EngineInterface } from 'claude-code'
import type { Source } from '../types'
import { heuristic } from './curate'
import { extractRefs, prIdFromUrl, prUrl } from './refs'
import { EMPTY, STATE_SHAPE, applyScores, setBranch, setHash, touchPrompt, trackedIds, upsertBranch, upsertRef } from './store'

const state = atom({ plugin: 'context-pane', key: 'state' } as const, EMPTY, { shape: STATE_SHAPE })

const OWN_TOOLS = 'mcp__context-pane__'
const GITDIR = 'gitdir: '
const HEAD_REF = 'ref: refs/heads/'
const GITHUB_REMOTE = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/

let sessionCwd: string | undefined

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
      if (use.tool.startsWith(OWN_TOOLS)) continue
      await collectText($, JSON.stringify(use.input), 'tool', projects)
      if (use.text) await collectText($, use.text, 'tool', projects)
    }
  }
}

async function treeUrl($: EngineInterface, branch: string): Promise<string> {
  try {
    const m = GITHUB_REMOTE.exec((await $.session.repo())?.remote ?? '')
    return m ? `https://github.com/${m[1]}/${m[2]}/tree/${branch}` : '#'
  } catch {
    return '#'
  }
}

async function collectBranchPr($: EngineInterface, cwd: string): Promise<void> {
  const run = await $.process.run(['gh', 'pr', 'view', '--json', 'number,url'], { cwd })
  if (run.exitCode !== 0) return
  const url = (JSON.parse(run.stdout) as { url?: unknown }).url
  if (typeof url !== 'string') return
  const id = prIdFromUrl(url)
  await update($, state, s => upsertRef(s, { id, kind: 'github-pr', href: prUrl(id), snippet: '' }, 'branch', Date.now()))
}

async function collectBranch($: EngineInterface, cwd: string, branch: string, projects: readonly string[]): Promise<void> {
  const href = await treeUrl($, branch)
  await update($, state, s => upsertBranch(setBranch(s, branch), { id: branch, kind: 'branch', href, snippet: '' }, Date.now()))
  await collectText($, branch, 'branch', projects)
}

async function rereadBranch($: EngineInterface, projects: readonly string[]): Promise<void> {
  if (!sessionCwd) return
  const cwd = sessionCwd
  const branch = await readBranch($, cwd)
  if (!branch || branch === (await read($, state)).branch) return
  await collectBranch($, cwd, branch, projects)
  void collectBranchPr($, cwd).catch(() => {})
}

async function scoreByHeuristic($: EngineInterface): Promise<void> {
  const now = Date.now()
  await update($, state, s => {
    const ids = trackedIds(s)
    if (ids.length === 0) return s
    return applyScores(s, Object.fromEntries(ids.map(id => [id, { score: heuristic(s.refs[id]!, s, now), why: '' }])), setHash(ids), now)
  })
}

export async function onPromptSubmit($: EngineInterface, e: { text: string }, next: (e: any) => Promise<any>, projects: readonly string[]) {
  await update($, state, s => touchPrompt(s, Date.now())).catch(() => {})
  await rereadBranch($, projects).catch(() => {})
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
  if (!e.agentId) await collectText($, e.answer, 'answer', projects).catch(() => {})
  return next(e)
}

export async function startCollecting($: EngineInterface, cwd: string, projects: readonly string[]): Promise<void> {
  sessionCwd = cwd
  try {
    await update($, state, s => touchPrompt(s, Date.now()))
    const isFresh = Object.keys((await read($, state)).refs).length === 0
    const branch = await readBranch($, cwd)
    if (branch) {
      await collectBranch($, cwd, branch, projects)
      await collectBranchPr($, cwd).catch(() => {})
    } else {
      await update($, state, s => setBranch(s, undefined))
    }
    if (isFresh) {
      await replay($, projects)
      await scoreByHeuristic($)
    }
  } catch {
    return
  }
}
