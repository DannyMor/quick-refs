import { atom, read } from 'claude-code'
import type { Register } from 'claude-code'
import type { ContextState, Ref } from '../types'
import { onPromptSubmit, onToolCallCollect, onTurnComplete, projectsFrom, startCollecting } from './collect'
import { onTurnCompleteCurate } from './curate'
import { renderPane } from './pane'
import { onPromptSubmitPoll, onToolCallObserveWrites, onTurnCompletePoll, startPolling } from './pollers'
import { STATE_SHAPE } from './store'
import {
  PANE, TOOL_PREFIX, onQuickRefsCommand, onNoteTool, onPaneClose, onPinTool, onRefreshTool, onTrackCommand, onTrackTool,
  onUntrackCommand, onUntrackTool, registerTools, shouldOpenUnasked,
} from './tools'

const closedByPerson = atom({ plugin: 'quick-refs', key: 'isClosedByPerson' } as const, false, { shape: 'closed-1' })

const demoRef = (id: string, kind: Ref['kind'], href: string, extra: Partial<Ref>): Ref => ({
  id, kind, href, firstSeen: 0, lastSeen: 0, mentions: 1, sources: ['prompt'], snippet: '', score: 0.5, why: '',
  pinned: false, untracked: false, notes: [], ...extra,
})

const demoState = (now: number): ContextState => {
  const fetchedAt = now - 60_000
  const refs: Ref[] = [
    demoRef('acme/app#412', 'github-pr', 'https://github.com/acme/app/pull/412', {
      score: 0.9, fetchedAt, card: { kind: 'github-pr', number: 412, title: 'Retry failed file uploads', state: 'open', checks: 'pass', reviewDecision: '' },
    }),
    demoRef('https://example.slack.com/archives/C0TEAMDEV0/p1731200000000100', 'slack', 'https://example.slack.com/archives/C0TEAMDEV0/p1731200000000100', {
      score: 0.9, fetchedAt, card: { kind: 'slack', channel: 'team-dev', replyCount: 7, participants: ['alex'], latest: { author: 'alex', age: '2m', text: 'retry three times' }, newSince: 2 },
    }),
    demoRef('PROJ-1234', 'jira', 'https://example.atlassian.net/browse/PROJ-1234', {
      score: 0.95, fetchedAt,
      card: {
        kind: 'jira', summary: 'Retry failed file uploads', status: 'In Progress', assignee: 'alex', blockers: ['PROJ-1201'],
        subtasks: [
          { key: 'PROJ-1235', status: 'Done', title: 'add retry test' },
          { key: 'PROJ-1236', status: 'Blocked', title: 'waiting on review' },
          { key: 'PROJ-1237', status: 'To Do', title: 'update docs' },
        ],
      },
    }),
    demoRef('PROJ-1234-upload-retry', 'branch', 'https://github.com/acme/app/tree/PROJ-1234-upload-retry', { score: 1 }),
    demoRef('PROJ-1201', 'jira', 'https://example.atlassian.net/browse/PROJ-1201', {
      score: 0.6, fetchedAt, why: 'blocker, mentioned twice',
      card: { kind: 'jira', summary: 'Large uploads time out', status: 'Open', assignee: '', blockers: [], subtasks: [] },
    }),
    demoRef('acme/app#398', 'github-pr', 'https://github.com/acme/app/pull/398', {
      score: 0.5, fetchedAt, why: 'prior fix, you read it',
      card: { kind: 'github-pr', number: 398, title: 'Raise the upload timeout', state: 'merged', checks: 'none', reviewDecision: 'APPROVED' },
    }),
    demoRef('https://example.slack.com/archives/team-oncall/p1731100000000200', 'slack', 'https://example.slack.com/archives/team-oncall/p1731100000000200', {
      score: 0.2, why: 'not mentioned lately',
    }),
  ]
  return {
    refs: Object.fromEntries(refs.map(r => [r.id, r])), branch: 'PROJ-1234-upload-retry',
    lastCuratedAt: now - 180_000, activity: 'active', lastPromptAt: now,
  }
}

export const register: Register = (on, options) => {
  const projects = projectsFrom(options)

  on('session.start', async ($, e, next) => {
    await registerTools($)
    if (shouldOpenUnasked(e.surface, await read($, closedByPerson))) {
      void $.ui.open({ id: PANE, title: 'Quick refs' })
    }
    await startCollecting($, e.cwd, projects)
    if (options.seedDemo === true) {
      await $.state.set({ plugin: 'quick-refs', key: 'state' }, { shape: STATE_SHAPE, value: demoState(Date.now()) })
    }
    startPolling($)
    return next(e)
  })

  on('prompt.submit', ($, e, next) => onPromptSubmitPoll($, e, x => onPromptSubmit($, x, next, projects))).catch(($, e, next) => next(e))
  on('tool.call', ($, e, next) => onToolCallCollect($, e, x => onToolCallObserveWrites($, x, next), projects)).catch(($, e, next) => next(e))
  on('turn.complete', ($, e, next) => onTurnComplete($, e, x => onTurnCompleteCurate($, x, y => onTurnCompletePoll($, y, next)), projects))

  on('tool.call', { tool: `${TOOL_PREFIX}note` }, ($, e) => onNoteTool($, e as never, projects))
  on('tool.call', { tool: `${TOOL_PREFIX}pin` }, ($, e) => onPinTool($, e as never, projects))
  on('tool.call', { tool: `${TOOL_PREFIX}track` }, ($, e) => onTrackTool($, e as never, projects))
  on('tool.call', { tool: `${TOOL_PREFIX}untrack` }, ($, e) => onUntrackTool($, e as never, projects))
  on('tool.call', { tool: `${TOOL_PREFIX}refresh` }, ($, e) => onRefreshTool($, e as never, projects))

  on('command.run', { command: 'quick-refs' }, $ => onQuickRefsCommand($))
  on('command.run', { command: 'track' }, ($, e) => onTrackCommand($, e, projects))
  on('command.run', { command: 'untrack' }, ($, e) => onUntrackCommand($, e, projects))

  on('ui.close', ($, e, next) => onPaneClose($, e, next))

  on('ui.render', { component: 'Pane', requestId: PANE }, renderPane)
}
