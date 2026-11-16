import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { connect, startServerGroup, type McpServer } from '../src/mcp.ts'

function fakeServer(name: string, closed: string[]): McpServer {
  return { name, close: async () => { closed.push(name) } } as McpServer
}

describe('startServerGroup', () => {
  it('waits for late successes, closes all successful servers, and preserves the startup error', async () => {
    const closed: string[] = []
    const failure = new Error('psql startup failed')
    let finishGitHub!: (server: McpServer) => void
    const github = new Promise<McpServer>(resolve => { finishGitHub = resolve })
    const result = startServerGroup({
      jj: async () => fakeServer('jj', closed),
      psql: async () => { throw failure },
      github: () => github,
    })
    let settled = false
    void result.finally(() => { settled = true }).catch(() => {})
    await Promise.resolve()
    assert.equal(settled, false)
    finishGitHub(fakeServer('github', closed))
    await assert.rejects(result, error => error === failure)
    assert.deepEqual(closed.sort(), ['github', 'jj'])
  })

  it('returns all servers when startup succeeds', async () => {
    const closed: string[] = []
    const servers = await startServerGroup({
      jj: async () => fakeServer('jj', closed),
      psql: async () => fakeServer('psql', closed),
      github: async () => fakeServer('github', closed),
    })
    assert.deepEqual(Object.keys(servers), ['jj', 'psql', 'github'])
    assert.deepEqual(closed, [])
  })
})

describe('connect', () => {
  it('closes a transport if connection fails', async () => {
    const failure = new Error('transport startup failed')
    let closes = 0
    const transport = {
      start: async () => { throw failure },
      close: async () => { closes++ },
      send: async () => {},
    } as unknown as StdioClientTransport
    await assert.rejects(connect('jj', transport), error => error === failure)
    assert.equal(closes, 1)
  })
})
