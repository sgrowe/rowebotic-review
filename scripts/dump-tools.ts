// Dump MCP tool schemas and instructions to test/fixtures/tools.json (used by stub tests).
import { writeFile } from 'node:fs/promises'
import { closeServers, startServers } from '../src/mcp.ts'

const servers = await startServers(process.argv[2] ?? process.cwd())
const out = Object.fromEntries(Object.values(servers).map(s => [s.name, { instructions: s.instructions ?? null, tools: s.tools }]))
await writeFile(new URL('../test/fixtures/tools.json', import.meta.url), `${JSON.stringify(out, null, 2)}\n`)
for (const s of Object.values(servers)) console.log(s.name, s.tools.map(t => t.name).join(' '), 'instructions:', s.instructions?.length ?? 0)
await closeServers(servers)
