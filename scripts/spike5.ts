// Spike 5: does a staggered second agent's first request hit the first agent's cache?
// Real reviewer instructions (with a per-trial nonce), real body. Compares per-agent
// session-id with session-id = cache key. Run: node scripts/spike5.ts [trials]
import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { TokenStore } from '../src/auth.ts'
import { PYTHON_TOOL, userMessage } from '../src/agent.ts'
import { buildStubs, mcpHostFunctions } from '../src/codemode.ts'
import { callModel, createClient } from '../src/model.ts'
import { buildInstructions, reviewerFormat } from '../src/review.ts'

const pi = JSON.parse(readFileSync(`${homedir()}/.pi/agent/auth.json`, 'utf8'))['openai-codex']
const tokens = new TokenStore(pi, '/nonexistent/auth.json')
const client = createClient(tokens)
const fx = JSON.parse(readFileSync(new URL('../test/fixtures/tools.json', import.meta.url), 'utf8'))
const srv = (name: string) => ({ name, tools: fx[name].tools, call: async () => '' }) as never
const prompt = (n: string) => readFileSync(new URL(`../src/prompts/${n}.md`, import.meta.url), 'utf8').trim()
const base = [prompt('reviewer'), prompt('codemode'), `## Functions\n\n\`\`\`python\n${buildStubs([...mcpHostFunctions(srv('jj')), ...mcpHostFunctions(srv('psql'))])}\`\`\``, fx.jj.instructions, fx.psql.instructions]
const trials = Number(process.argv[2] ?? 6)
const signal = new AbortController().signal
const results: Record<string, string[]> = { perAgent: [], sharedSid: [] }
for (let i = 0; i < trials; i++) {
  for (const mode of i % 2 ? ['sharedSid', 'perAgent'] : ['perAgent', 'sharedSid']) {
    const nonce = randomUUID()
    const instructions = buildInstructions([`Trial ${nonce}.`, ...base])
    const key = `spike5:${nonce.slice(0, 8)}`
    const call = (who: string) =>
      callModel(client, {
        instructions,
        tools: [PYTHON_TOOL],
        textFormat: reviewerFormat,
        promptCacheKey: key,
        sessionId: mode === 'sharedSid' ? key : randomUUID(),
        input: [userMessage(`Connectivity test for agent ${who}. Do not call tools. Reply with {"findings": []}.`)],
      }, { signal })
    const a = await call('A')
    const b = await call('B')
    results[mode]!.push(`${a.usage.cached}/${b.usage.cached}of${b.usage.input}`)
  }
}
console.log(JSON.stringify(results, null, 1))
