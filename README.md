# context-pane

A Claude Code mod that keeps the Jira issues, Slack threads, GitHub pull requests and git branch a session touches in one pane beside the chat. Every id is a link. Refreshing costs API calls, not model tokens.

## Install

To run the plugin from a local clone in a terminal session:

```
claude --plugin-dir <path to the clone>
```

## Use

The pane opens on its own on desktop only. In the terminal, run `/context-pane` (`/context` is a Claude Code built-in, hence the name). Closing the pane yourself keeps it closed after a reload until you run `/context-pane` again.

- `/context-pane` opens the pane.
- `/track <ref>` starts tracking a Jira key, Slack permalink or PR url.
- `/untrack <ref>` hides a reference until you mention it again in a prompt.

The model gets tools too. `note` (attach a one-line note to a reference) and `pin` (make a reference primary) are always listed. `track`, `untrack` and `refresh` sit behind tool search.

## Config

Set as `pluginConfigs["context-pane"].options.<field>` in `~/.claude/settings.json`:

- `projects`: comma-separated Jira project keys, default `PROJ`.
- `seedDemo`: boolean, fills the pane with demo rows at session start, default `false`.

## What the pane shows

Four columns: icon, link, info, status. The primary group comes first, in this order: PR, Slack thread, Jira issue with its sub-tasks, branch. Then an "also referenced" divider and the rest, ordered by score. A footer shows when the cards and the ranking were last updated, and `paused` when idle.

References come from the branch, your prompts, tool traffic and the model's answers. Jira and Slack are read through the connected claude.ai connectors, GitHub through `gh`. Nothing is written to any of them by the pane.

## When it polls

A poll only repaints a card when its fingerprint changed. A Jira or Slack write made in the session refreshes that card at once, and so does a `gh pr` write that names the PR number and repo.

| Level | Since last prompt | Jira | Slack | PR |
|---|---|---|---|---|
| active | under 30 min | 15 min | 3 min | 5 min |
| quiet | 30 min to 2 h | 30 min | 20 min | 20 min |
| idle | over 2 h | off | off | off |

The next prompt sets the level back to active.

## Ranking

Haiku ranks the references only when the reference set changes, at most once per 5 minutes, never from a poller. If the call fails, a heuristic score is used instead.
