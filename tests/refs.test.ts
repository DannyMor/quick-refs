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

test('a slack url with trailing punctuation and a query normalizes to one id', () => {
  expect(slackIdFromUrl('https://example.slack.com/archives/C0AB/p17311?thread_ts=1.2).')).toBe('https://example.slack.com/archives/C0AB/p17311')
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
