// Spike 2: session-id = cache key shared by two "agents"; immediate vs delayed repeat.
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { setTimeout as sleep } from 'node:timers/promises'
import OpenAI from 'openai'

const c = JSON.parse(await readFile(`${homedir()}/.pi/agent/auth.json`, 'utf8'))['openai-codex']
const client = new OpenAI({
  apiKey: c.access, baseURL: 'https://chatgpt.com/backend-api/codex', organization: null, project: null, maxRetries: 0,
  defaultHeaders: { 'chatgpt-account-id': c.accountId, originator: 'rowebotic-review', 'OpenAI-Beta': 'responses=experimental' },
})
const filler = Array.from({ length: 400 }, (_, i) => `- Rule ${i}: when reviewing item ${i}, check value ${i * 7} against limit ${i * 13}.`).join('\n')
const key = `spike2:${randomUUID().slice(0, 8)}`
const mode = process.argv[2] ?? 'key'
async function call(text: string, sessionId: string, label: string) {
  const { data, response } = await client.responses.create({
    model: 'gpt-6.1-sol', instructions: `Reply briefly.\n${filler}`, store: false, stream: true,
    input: [{ role: 'user', content: [{ type: 'input_text', text }] }],
    reasoning: { effort: 'high', summary: 'auto' }, include: ['reasoning.encrypted_content'], prompt_cache_key: key,
    text: { verbosity: 'low' },
  } as any, { headers: { 'session-id': sessionId } }).withResponse()
  let usage: any
  for await (const e of data as any) if (e.type === 'response.completed') usage = e.response.usage
  console.log(label, 'in', usage.input_tokens, 'cached', usage.input_tokens_details?.cached_tokens)
  return response
}
const sidA = mode === 'key' ? key : randomUUID()
const sidB = mode === 'key' ? key : randomUUID()
const r = await call('Say A1.', sidA, `[${mode}] agent A turn 1`)
console.log('headers', [...r.headers.keys()].join(' '))
await call('Say A2.', sidA, `[${mode}] agent A immediate repeat`)
await sleep(5000)
await call('Say A3.', sidA, `[${mode}] agent A +5s`)
await call('Say B1.', sidB, `[${mode}] agent B turn 1`)
await call('Say B2.', sidB, `[${mode}] agent B turn 2`)
