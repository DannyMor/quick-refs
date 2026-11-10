import { test, expect } from 'claude-code/testing'
import { extractRefs, prIdFromUrl, slackIdFromUrl } from '../hooks/refs'

test('finds a Jira key, a Slack permalink and a PR url in prose', () => {
  const text = 'work on PROJ-1234, see https://example.slack.com/archives/C0AB12CD/p1731150000123456?thread_ts=1731150000.123456). PR https://github.com/acme/app/pull/412 is up.'
  const found = extractRefs(text, ['PROJ'])
  expect(found.map(f => f.id)).toEqual(['PROJ-1234', 'https://example.slack.com/archives/C0AB12CD/p1731150000123456', 'acme/app#412'])
  expect(found[0]?.kind).toBe('jira')
  expect(found[1]?.kind).toBe('slack')
  expect(found[2]?.kind).toBe('github-pr')
})

test('ignores keys of other projects and dedupes repeats', () => {
  const found = extractRefs('OPS-9 and PROJ-7 and PROJ-7 again', ['PROJ'])
  expect(found.map(f => f.id)).toEqual(['PROJ-7'])
})

test('a slack reply url with trailing punctuation normalizes to its parent thread', () => {
  expect(slackIdFromUrl('https://example.slack.com/archives/C0AB/p1731150000999999?thread_ts=1731150000.123456&cid=C0AB).'))
    .toBe('https://example.slack.com/archives/C0AB/p1731150000123456')
  expect(slackIdFromUrl('https://example.slack.com/archives/C0AB/p1731150000123456).')).toBe('https://example.slack.com/archives/C0AB/p1731150000123456')
})

test('a bare parent link and a reply link to it give one id', () => {
  const parent = 'https://example.slack.com/archives/C0AB12CD/p1731150000123456'
  const reply = 'https://example.slack.com/archives/C0AB12CD/p1731150000999999?thread_ts=1731150000.123456&cid=C0AB12CD'
  const found = extractRefs(`see ${parent} and the reply ${reply}`, ['PROJ'])
  expect(found.map(f => [f.id, f.href])).toEqual([[parent, parent]])
})

test('snippet is the sentence around the hit, at most 200 chars', () => {
  const long = 'x'.repeat(300) + ' PROJ-1 ' + 'y'.repeat(300)
  const [found] = extractRefs(long, ['PROJ'])
  expect(found?.snippet.length).toBeLessThanOrEqual(200)
  expect(found?.snippet).toContain('PROJ-1')
})

test('pr id round-trips', () => {
  expect(prIdFromUrl('https://github.com/acme/app/pull/412')).toBe('acme/app#412')
})
