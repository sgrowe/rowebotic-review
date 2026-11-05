// Spike 4: does agent B's first request hit A's cache when it borrows A's x-codex-turn-state?
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import OpenAI from 'openai'

const c = JSON.parse(await readFile(`${homedir()}/.pi/agent/auth.json`, 'utf8'))['openai-codex']
const client = new OpenAI({
  apiKey: c.access, baseURL: 'https://chatgpt.com/backend-api/codex', organization: null, project: null, maxRetries: 0,
  defaultHeaders: { 'chatgpt-account-id': c.accountId, originator: 'rowebotic-review', 'OpenAI-Beta': 'responses=experimental' },
})
const filler = Array.from({ length: 400 }, (_, i) => `- Rule ${i}: when reviewing item ${i}, check value ${i * 7} against limit ${i * 13}.`).join('\n')
const borrow = process.argv[2] === 'borrow'
async function call(key: string, text: string, turnState: string | null) {
  const headers: Record<string, string> = { 'session-id': key }
  if (turnState) headers['x-codex-turn-state'] = turnState
  const { data, response } = await client.responses.create({
    model: 'gpt-6.1-sol', instructions: `Reply briefly.\n${filler}`, store: false, stream: true,
    input: [{ role: 'user', content: [{ type: 'input_text', text }] }],
    reasoning: { effort: 'high', summary: 'auto' }, include: ['reasoning.encrypted_content'], prompt_cache_key: key,
    text: { verbosity: 'low' },
  } as any, { headers }).withResponse()
  let usage: any
  for await (const e of data as any) if (e.type === 'response.completed') usage = e.response.usage
  return { ts: response.headers.get('x-codex-turn-state'), cached: usage.input_tokens_details?.cached_tokens as number }
}
const out: string[] = []
for (let trial = 0; trial < 4; trial++) {
  const key = `spike4:${randomUUID().slice(0, 8)}`
  const a = await call(key, `Agent A says ${trial}.`, null)
  const b = await call(key, `Agent B says ${trial}.`, borrow ? a.ts : null)
  const c2 = await call(key, `Agent C says ${trial}.`, borrow ? a.ts : null)
  out.push(`A${a.cached} B${b.cached} C${c2.cached}`)
}
console.log(borrow ? 'borrow ' : 'fresh  ', out.join(' | '))
