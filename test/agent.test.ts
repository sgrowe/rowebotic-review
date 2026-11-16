import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { AgentOutputError, ToolArgumentError, type ModelCaller, NUDGE, runAgent } from '../src/agent.ts'
import type { AgentRequest, Item, ModelResponse } from '../src/model.ts'
import { Transcript } from '../src/transcript.ts'

function response(output: Item[], input: number, cached: number): ModelResponse {
  return { output, usage: { input, cached, output: 5, reasoning: 2 }, requestId: 'r', turnState: 'ts', durationMs: 10, requestBytes: 100, status: 'completed' }
}

const call = (id: string, code: string): Item => ({ type: 'function_call', id: `fc_${id}`, call_id: id, name: 'python', arguments: JSON.stringify({ code }) })
const reasoning = (id: string): Item => ({ type: 'reasoning', id, encrypted_content: `enc_${id}`, summary: [] })
const message = (text: string): Item => ({ type: 'message', id: `m_${text.length}`, role: 'assistant', content: [{ type: 'output_text', text }] })

async function setup(outputs: Item[][]) {
  const dir = await mkdtemp(join(tmpdir(), 'rr-agent-'))
  const lines: string[] = []
  const transcript = new Transcript(join(dir, 'run.jsonl'), line => lines.push(line))
  const requests: { snapshot: string; req: AgentRequest; inputLength: number }[] = []
  let n = 0
  const model: ModelCaller = async req => {
    requests.push({ snapshot: JSON.stringify(req.input), req: { ...req }, inputLength: req.input.length })
    const output = outputs.shift()
    if (!output) throw new Error('no more outputs')
    n++
    return response(output, 1000 * n, n === 3 ? 0 : 900 * n)
  }
  const codes: string[] = []
  const codemode = {
    run: async (code: string) => {
      codes.push(code)
      return { output: `ran ${code}`, calls: [], durationMs: 1 }
    },
  }
  const spec = {
    id: 'bugs',
    role: 'reviewer' as const,
    instructions: 'instr',
    promptCacheKey: 'o/r:reviewer',
    textFormat: { type: 'json_schema', name: 'x', strict: true, schema: {} },
    firstMessage: 'review this',
    codemode,
    signal: new AbortController().signal,
  }
  return { transcript, model, requests, codes, spec, lines, path: join(dir, 'run.jsonl') }
}

describe('runAgent', () => {
  it('appends output and tool results, keeps request fields constant, and returns the final JSON', async () => {
    let first = 0
    const t = await setup([
      [reasoning('r1'), call('c1', 'x = 1')],
      [reasoning('r2'), message('checking'), call('c2', 'x + 1')],
      [reasoning('r3'), message('{"findings":[]}')],
    ])
    const result = await runAgent({ ...t.spec, onFirstResponse: () => first++ }, { transcript: t.transcript, model: t.model })
    assert.deepEqual(result, { findings: [] })
    assert.equal(first, 1)
    assert.deepEqual(t.codes, ['x = 1', 'x + 1'])

    // Each request's input starts with the previous request's input: append-only.
    for (let i = 1; i < t.requests.length; i++) {
      const previous = JSON.parse(t.requests[i - 1]!.snapshot) as unknown[]
      const current = JSON.parse(t.requests[i]!.snapshot) as unknown[]
      assert.deepEqual(current.slice(0, previous.length), previous)
    }
    const last = JSON.parse(t.requests[2]!.snapshot) as Item[]
    assert.deepEqual(last.map(item => item.type ?? item.role), ['user', 'reasoning', 'function_call', 'function_call_output', 'reasoning', 'message', 'function_call', 'function_call_output'])
    assert.equal(last[1]!.encrypted_content, 'enc_r1')
    assert.equal(last[3]!.output, 'ran x = 1')

    for (const { req } of t.requests) {
      assert.equal(req.instructions, 'instr')
      assert.equal(req.promptCacheKey, 'o/r:reviewer')
      assert.equal(req.sessionId, t.requests[0]!.req.sessionId)
    }
    assert.equal(t.requests[0]!.req.turnState, undefined)
    assert.equal(t.requests[1]!.req.turnState, 'ts')

    const records = (await readFile(t.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const types = records.map(r => r.type)
    for (const type of ['agent_start', 'request', 'response', 'code_exec', 'cache_miss', 'agent_end']) assert.ok(types.includes(type), type)
    const totals = t.transcript.totals('bugs')
    assert.deepEqual([totals.turns, totals.input, totals.first.input, totals.later.input], [3, 6000, 1000, 5000])
  })

  it('nudges once on an empty answer, then fails', async () => {
    const t = await setup([[reasoning('r1')], [message('')]])
    await assert.rejects(runAgent(t.spec, { transcript: t.transcript, model: t.model }), AgentOutputError)
    const second = JSON.parse(t.requests[1]!.snapshot) as Item[]
    assert.equal(second.at(-1)!.content[0].text, NUDGE)
  })

  it('accepts the answer after a nudge', async () => {
    const t = await setup([[message('done')], [message('{"findings":[{"file":"a"}]}')]])
    assert.deepEqual(await runAgent(t.spec, { transcript: t.transcript, model: t.model }), { findings: [{ file: 'a' }] })
  })

  it('throws the abort reason', async () => {
    const t = await setup([[call('c1', 'x')]])
    const controller = new AbortController()
    controller.abort(new Error('run stopped'))
    await assert.rejects(runAgent({ ...t.spec, signal: controller.signal }, { transcript: t.transcript, model: t.model }), /run stopped/)
  })
})


describe('direct agent tools', () => {
  const schema = { type: 'function', name: 'review_batch', parameters: { type: 'object' } }
  const direct = (id: string, arguments_ = '{"reviewers":[]}'): Item => ({ type: 'function_call', call_id: id, name: 'review_batch', arguments: arguments_ })

  it('routes direct calls without Python, keeps tools/history stable, and preserves complete results', async () => {
    const fullResult = [{ key: 'bugs', findings: [{ evidence: 'x'.repeat(310_000) }] }]
    const t = await setup([[call('p1', 'saved = 42')], [direct('d1')], [call('p2', 'saved')], [message('{"done":true}')]])
    const received: unknown[] = []
    const additionalTools = [{ schema, call: async (args: unknown, signal: AbortSignal) => {
      assert.equal(signal, t.spec.signal)
      received.push(args)
      return fullResult
    } }]
    await runAgent({ ...t.spec, role: 'orchestrator', additionalTools }, { transcript: t.transcript, model: t.model })
    assert.deepEqual(received, [{ reviewers: [] }])
    assert.deepEqual(t.codes, ['saved = 42', 'saved'])
    for (const { req } of t.requests) assert.deepEqual(req.tools.map(tool => tool.name), ['python', 'review_batch'])
    const history = JSON.parse(t.requests.at(-1)!.snapshot) as Item[]
    const result = history.find(item => item.type === 'function_call_output' && item.call_id === 'd1')!
    assert.deepEqual(JSON.parse(result.output), fullResult)
    for (let i = 1; i < t.requests.length; i++) {
      const previous = JSON.parse(t.requests[i - 1]!.snapshot) as Item[]
      assert.deepEqual(JSON.parse(t.requests[i]!.snapshot).slice(0, previous.length), previous)
    }
    const records = (await readFile(t.path, 'utf8')).trim().split('\n').map(line => JSON.parse(line))
    const execution = records.find(row => row.type === 'tool_exec')
    assert.equal(execution.callId, 'd1')
    assert.equal(execution.tool, 'review_batch')
    assert.deepEqual(execution.arguments, { reviewers: [] })
    assert.deepEqual(execution.result, fullResult)
    assert.equal(execution.error, null)
  })

  it('returns correctable errors for unknown tools, invalid JSON, and malformed arguments', async () => {
    const t = await setup([[{ ...direct('unknown'), name: 'missing' }], [direct('json', '{')], [direct('shape', 'null')], [message('{"done":true}')]])
    let called = 0
    await runAgent({ ...t.spec, additionalTools: [{ schema, call: async () => {
      called++
      throw new ToolArgumentError('reviewers must be an array')
    } }] }, { transcript: t.transcript, model: t.model })
    assert.equal(called, 1)
    const results = (JSON.parse(t.requests.at(-1)!.snapshot) as Item[]).filter(item => item.type === 'function_call_output')
    assert.match(results[0]!.output, /Available tools: python, review_batch/)
    assert.match(results[1]!.output, /valid JSON/)
    assert.match(results[2]!.output, /reviewers must be an array/)
  })

  it('propagates unexpected handler failures and defaults reviewers to Python only', async () => {
    const t = await setup([[direct('d')]])
    await assert.rejects(runAgent({ ...t.spec, additionalTools: [{ schema, call: async () => { throw new Error('fatal') } }] }, { transcript: t.transcript, model: t.model }), /fatal/)
    const reviewer = await setup([[message('{"findings":[]}')]])
    await runAgent(reviewer.spec, { transcript: reviewer.transcript, model: reviewer.model })
    assert.deepEqual(reviewer.requests[0]!.req.tools.map(tool => tool.name), ['python'])
  })
})
