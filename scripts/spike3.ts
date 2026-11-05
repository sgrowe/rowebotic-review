// Spike 3: cache hit rate over sequential calls, with and without echoing x-codex-turn-state.
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
const echo = process.argv[2] === 'echo'
const key = `spike3:${randomUUID().slice(0, 8)}`
let turnState: string | null = null
const input: any[] = []
const results: string[] = []
for (let i = 0; i < 8; i++) {
  input.push({ role: 'user', content: [{ type: 'input_text', text: `Say ${i}.` }] })
  const headers: Record<string, string> = { 'session-id': key }
  if (echo && turnState) headers['x-codex-turn-state'] = turnState
  const { data, response } = await client.responses.create({
    model: 'gpt-6.1-sol', instructions: `Reply briefly.\n${filler}`, store: false, stream: true, input,
    reasoning: { effort: 'high', summary: 'auto' }, include: ['reasoning.encrypted_content'], prompt_cache_key: key,
    text: { verbosity: 'low' },
  } as any, { headers }).withResponse()
  if (i === 0) console.log('turn-state sample', response.headers.get('x-codex-turn-state')?.slice(0, 60))
  turnState = response.headers.get('x-codex-turn-state') ?? turnState
  let usage: any
  for await (const e of data as any) {
    if (e.type === 'response.output_item.done') input.push(e.item)
    if (e.type === 'response.completed') usage = e.response.usage
  }
  results.push(`${usage.input_tokens}/${usage.input_tokens_details?.cached_tokens}`)
}
console.log(echo ? 'echo  ' : 'no-echo', results.join(' '))
