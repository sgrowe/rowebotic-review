// MCP clients: jj and psql over stdio, GitHub over streamable HTTP.
// One of each per run, shared by all agents.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

const execFileAsync = promisify(execFile)

export type JsonSchema = {
  type?: string | string[]
  properties?: Record<string, JsonSchema>
  required?: string[]
  items?: JsonSchema
  enum?: unknown[]
  description?: string
  [key: string]: unknown
}

export type McpTool = {
  server: string
  name: string
  description: string
  inputSchema: JsonSchema
}

export class McpServer {
  readonly name: string
  readonly client: Client
  readonly tools: McpTool[]
  readonly instructions: string | undefined

  constructor(name: string, client: Client, tools: McpTool[], instructions: string | undefined) {
    this.name = name
    this.client = client
    this.tools = tools
    this.instructions = instructions
  }

  /** Call a tool and return its text content. `isError` results throw. */
  async call(tool: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<string> {
    const result = await this.client.callTool({ name: tool, arguments: args }, undefined, {
      signal,
      // Large diffs and searches can be slow; the agent timeout bounds the rest.
      timeout: 10 * 60 * 1000,
      resetTimeoutOnProgress: true,
    })
    const text = mcpResultText(result)
    if (result.isError) throw new McpToolError(text || `${tool} failed`)
    return text
  }

  async close(): Promise<void> {
    await this.client.close().catch(() => {})
  }
}

export class McpToolError extends Error {
  override name = 'McpToolError'
}

export function mcpResultText(result: { content?: unknown; structuredContent?: unknown; [key: string]: unknown }): string {
  const parts: string[] = []
  for (const block of (result.content as { type: string; text?: string }[] | undefined) ?? []) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else parts.push(JSON.stringify(block))
  }
  if (parts.length === 0 && result.structuredContent !== undefined) parts.push(JSON.stringify(result.structuredContent))
  return parts.join('\n')
}

async function connect(name: string, transport: StdioClientTransport | StreamableHTTPClientTransport, only?: Set<string>) {
  const client = new Client({ name: 'rowebotic-review', version: '0.1.0' })
  await client.connect(transport)
  const tools: McpTool[] = []
  let cursor: string | undefined
  do {
    const page = await client.listTools({ cursor })
    for (const tool of page.tools) {
      if (only && !only.has(tool.name)) continue
      tools.push({
        server: name,
        name: tool.name,
        description: tool.description ?? '',
        inputSchema: tool.inputSchema as JsonSchema,
      })
    }
    cursor = page.nextCursor
  } while (cursor)
  return new McpServer(name, client, tools, client.getInstructions())
}

export async function startStdio(name: string, command: string, cwd: string): Promise<McpServer> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value
  return connect(name, new StdioClientTransport({ command, args: [], cwd, env, stderr: 'inherit' }))
}

export const githubTools = ['pull_request_read', 'pull_request_review_write', 'add_comment_to_pending_review'] as const

export async function startGitHub(): Promise<McpServer> {
  const { stdout } = await execFileAsync('gh', ['auth', 'token', '--hostname', 'github.com'])
  const transport = new StreamableHTTPClientTransport(new URL('https://api.githubcopilot.com/mcp/'), {
    requestInit: { headers: { Authorization: `Bearer ${stdout.trim()}` } },
  })
  return connect('github', transport, new Set(githubTools))
}

export type McpServers = { jj: McpServer; psql: McpServer; github: McpServer }

export async function startServers(cwd: string): Promise<McpServers> {
  const [jj, psql, github] = await Promise.all([
    startStdio('jj', 'jj-read-only-mcp', cwd),
    startStdio('psql', 'psql-schema-mcp', cwd),
    startGitHub(),
  ])
  return { jj, psql, github }
}

export async function closeServers(servers: Partial<McpServers>): Promise<void> {
  await Promise.all(Object.values(servers).map(server => server?.close()))
}
