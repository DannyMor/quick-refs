import type { EngineInterface } from 'claude-code'

export class NotConnected extends Error {}

export type McpOutcome = { value: unknown; error?: undefined } | { value?: undefined; error: string }

const NOT_CONNECTED = /unknown server|not connected|no (such )?server|server not found|disconnected/i
const ERROR_MAX = 120

export const firstLine = (text: string): string => (text.trim().split('\n')[0] ?? '').slice(0, ERROR_MAX)

const parse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

export async function callMcp($: EngineInterface, server: string, tool: string, args: Record<string, unknown>): Promise<McpOutcome> {
  let result
  try {
    result = await $.mcp.call(server, tool, args)
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    if (NOT_CONNECTED.test(message)) throw new NotConnected(message)
    throw err
  }
  const text = result.content.map(b => (b.type === 'text' && typeof b.text === 'string' ? b.text : '')).join('')
  if (result.isError) return { error: firstLine(text) || `${tool} failed` }
  const value = result.structuredContent ?? parse(text)
  return value === undefined ? { error: `unreadable ${tool} result` } : { value }
}
