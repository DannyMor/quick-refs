export type RefKind = 'jira' | 'slack' | 'github-pr' | 'branch'

export type Source = 'branch' | 'prompt' | 'tool' | 'answer' | 'manual'

export type Found = { id: string; kind: RefKind; href: string; snippet: string }

export type Card =
  | { kind: 'jira'; summary: string; status: string; assignee: string; blockers: string[]; subtasks: Array<{ key: string; status: string }>; lastComment?: { author: string; age: string; text: string } }
  | { kind: 'slack'; channel: string; replyCount: number; participants: string[]; latest: { author: string; age: string; text: string }; newSince: number }
  | { kind: 'github-pr'; number: number; title: string; state: 'open' | 'merged' | 'closed'; checks: 'pass' | 'fail' | 'pending' | 'none'; reviewDecision: string }

export type Note = { text: string; kind: 'action' | 'fact'; done: boolean; at: number }

export type Ref = {
  id: string
  kind: RefKind
  href: string
  firstSeen: number
  lastSeen: number
  mentions: number
  sources: Source[]
  snippet: string
  score: number
  why: string
  pinned: boolean
  untracked: boolean
  card?: Card
  fingerprint?: string
  fetchedAt?: number
  error?: string
  notes: Note[]
}

export type ContextState = unknown

declare module 'claude-code' {
  interface PluginState {
    'context-pane': { state: Shaped<ContextState>; isClosedByPerson: Shaped<boolean> }
  }
}
