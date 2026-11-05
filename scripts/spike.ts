// Spike against the Codex backend. Uses pi's access token read-only (no refresh)
// unless ~/.rowebotic-review/auth.json exists.
// Run: node scripts/spike.ts

import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import OpenAI from 'openai'
import { loadCredentials } from '../src/auth.ts'

async function creds() {
  try {
    return await loadCredentials()
  } catch {
    const pi = JSON.parse(await readFile(`${homedir()}/.pi/agent/auth.json`, 'utf8'))['openai-codex']
    return pi as { access: string; accountId: string }
  }
}

const c = await creds()
const client = new OpenAI({
  apiKey: c.access,
  baseURL: 'https://chatgpt.com/backend-api/codex',
  organization: null,
  project: null,
  maxRetries: 0,
  defaultHeaders: {
    'chatgpt-account-id': c.accountId,
    originator: 'rowebotic-review',
    'OpenAI-Beta': 'responses=experimental',
  },
})

const filler = Array.from({ length: 400 }, (_, i) => `- Rule ${i}: when reviewing item ${i}, check the value ${i * 7} against limit ${i * 13}.`).join('\n')
const instructions = `You are a test agent. Use the python tool when asked to compute. Reply in the JSON schema.\n\n${filler}`
const cacheKey = `spike:${randomUUID().slice(0, 8)}`

const baseBody = {
  model: 'gpt-6.1-sol',
  instructions,
  tools: [
    {
      type: 'function' as const,
      name: 'python',
      description: 'Run Python code',
      parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'], additionalProperties: false },
      strict: true,
    },
  ],
  tool_choice: 'auto' as const,
  parallel_tool_calls: false,
  reasoning: { effort: 'high' as const, summary: 'auto' as const },
  store: false,
  stream: true as const,
  include: ['reasoning.encrypted_content' as const],
  prompt_cache_key: cacheKey,
  text: {
    format: {
      type: 'json_schema' as const,
      name: 'answer',
      strict: true,
      schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'], additionalProperties: false },
    },
    verbosity: 'low' as const,
  },
}

async function call(input: any[], sessionId: string, extra: Record<string, unknown> = {}) {
  const t0 = Date.now()
  const { data: stream, response } = await client.responses
    .create({ ...baseBody, ...extra, input } as any, { headers: { 'session-id': sessionId } })
    .withResponse()
  const done: any[] = []
  let completed: any
  const types = new Map<string, number>()
  for await (const event of stream as any) {
    types.set(event.type, (types.get(event.type) ?? 0) + 1)
    if (event.type === 'response.output_item.done') done[event.output_index] = event.item
    if (event.type === 'response.completed' || event.type === 'response.done') completed = event.response
  }
  const u = completed?.usage
  console.log(
    `status ${response.status} req ${response.headers.get('x-request-id')} ${Date.now() - t0}ms in ${u?.input_tokens} cached ${u?.input_tokens_details?.cached_tokens} out ${u?.output_tokens} reasoning ${u?.output_tokens_details?.reasoning_tokens}`,
  )
  console.log('  events', Object.fromEntries(types))
  console.log('  done items', done.map(i => `${i.type}${i.type === 'message' ? `(${i.phase ?? ''}) ${JSON.stringify(i.content?.map((c: any) => c.text))}` : ''}${i.type === 'reasoning' ? ` enc=${!!i.encrypted_content}` : ''}${i.type === 'function_call' ? ` ${i.arguments}` : ''}`))
  console.log('  completed.output', completed?.output?.length, completed?.output?.map((i: any) => i.type))
  return { done: done.filter(Boolean), completed }
}

const sessionA = randomUUID()
console.log('== 1. first call (expects function_call)')
const input: any[] = [{ role: 'user', content: [{ type: 'input_text', text: 'Use the python tool to compute 1234*5678, then answer.' }] }]
const r1 = await call(input, sessionA)
input.push(...r1.done)
for (const item of r1.done) {
  if (item.type === 'function_call') input.push({ type: 'function_call_output', call_id: item.call_id, output: '7006652' })
}
console.log('== 2. replay with function_call_output (store:false)')
const r2 = await call(input, sessionA)
input.push(...r2.done)

console.log('== 3. repeat identical prefix, same session (cache)')
await call([...input, { role: 'user', content: [{ type: 'input_text', text: 'Say ok.' }] }], sessionA)

console.log('== 4. same key, different session-id')
await call([...input, { role: 'user', content: [{ type: 'input_text', text: 'Say ok again.' }] }], randomUUID())

console.log('== 5. prompt_cache_retention 24h')
try {
  await call([{ role: 'user', content: [{ type: 'input_text', text: 'Say hi.' }] }], sessionA, { prompt_cache_retention: '24h' })
} catch (error) {
  console.log('  rejected:', (error as Error).message)
}
