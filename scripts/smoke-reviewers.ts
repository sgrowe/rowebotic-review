// Live smoke test without GitHub writes: two staggered reviewers on one PR head.
// Usage (from the repo root under review): node <this> <headSha> [concernA] [concernB]
// Uses ~/.rowebotic-review/auth.json, or pi's access token read-only if missing.
import { readFile } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadCredentials, TokenStore } from '../src/auth.ts'
import { modelCaller, runAgent } from '../src/agent.ts'
import { buildStubs, CodeMode, createPool, type HostFunction, mcpHostFunctions } from '../src/codemode.ts'
import { loadProject } from '../src/config.ts'
import { run } from '../src/github.ts'
import { closeServers, startStdio } from '../src/mcp.ts'
import { createClient } from '../src/model.ts'
import { buildInstructions, readDocStub, reviewerFormat } from '../src/review.ts'
import { Transcript } from '../src/transcript.ts'

const [sha, a = 'bugs', b = 'design'] = process.argv.slice(2)
if (!sha) throw new Error('usage: smoke-reviewers.ts <headSha> [concernA] [concernB]')
const root = process.cwd()
const project = await loadProject(process.env.RR_PROJECT ?? root)
let tokens: TokenStore
try {
  tokens = new TokenStore(await loadCredentials())
} catch {
  const pi = JSON.parse(await readFile(`${homedir()}/.pi/agent/auth.json`, 'utf8'))['openai-codex']
  tokens = new TokenStore(pi, join(tmpdir(), 'rr-smoke-auth.json'))
}
const model = modelCaller(createClient(tokens), tokens)
const transcript = new Transcript(join(homedir(), '.rowebotic-review', 'sessions', `${new Date().toISOString().replace(/[:.]/g, '-')}_smoke.jsonl`))
const [jj, psql] = await Promise.all([startStdio('jj', 'jj-read-only-mcp', root), startStdio('psql', 'psql-schema-mcp', root)])
const pool = await createPool()
const docs = [...project.docs.keys()].sort()
const readDoc: HostFunction[] = docs.length ? [{ name: 'read_doc', stub: readDocStub(docs), call: async args => project.docs.get(String(args.name)) ?? 'no such doc' }] : []
const functions = [...mcpHostFunctions(jj), ...mcpHostFunctions(psql), ...readDoc]
const prompt = (n: string) => readFile(new URL(`../src/prompts/${n}.md`, import.meta.url), 'utf8')
const instructions = buildInstructions([
  (await prompt('reviewer')).trim(),
  (await prompt('codemode')).trim(),
  `## Functions\n\n\`\`\`python\n${buildStubs(functions)}\`\`\``,
  jj.instructions && `## jj functions\n\n${jj.instructions.trim()}`,
  psql.instructions && `## psql functions\n\n${psql.instructions.trim()}`,
  project.instructions && `## Repository instructions\n\n${project.instructions}`,
])
const changeId = (await run('jj', ['log', '-r', sha, '-T', 'change_id', '--no-graph', '--ignore-working-copy'], { cwd: root })).trim()
let open!: () => void
const gate = new Promise<void>(resolve => (open = resolve))
async function reviewer(concernName: string, first: boolean) {
  if (!first) await gate
  const concern = project.concerns.find(c => c.name === concernName)!
  const signal = AbortSignal.timeout(20 * 60 * 1000)
  const codemode = new CodeMode({ pool, functions, signal })
  try {
    return await runAgent(
      {
        id: concernName,
        role: 'reviewer',
        instructions,
        promptCacheKey: 'smoke:reviewer',
        textFormat: reviewerFormat,
        firstMessage: [concern.body, '---', `Change: ${changeId}`, `from: fork_point(trunk() | ${sha})`, `to: ${sha}`, 'Path scope: all changed files', 'Intent: see the change description.'].join('\n\n'),
        codemode,
        signal,
        onFirstResponse: first ? open : undefined,
      },
      { transcript, model },
    )
  } finally {
    if (first) open()
    await codemode.close()
  }
}
try {
  const results = await Promise.allSettled([reviewer(a, true), reviewer(b, false)])
  console.log(JSON.stringify(results, null, 1))
  for (const line of transcript.summaryLines()) console.log(line)
  console.log('transcript', transcript.path, 'instructions chars', instructions.length)
} finally {
  await pool.close()
  await closeServers({ jj, psql } as never)
  process.exit(0)
}
