import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { APIConnectionError, APIError, InternalServerError, RateLimitError } from 'openai'
import { AuthError, type Credentials, TokenStore } from '../src/auth.ts'
import {
  type AgentRequest,
  backoffDelay,
  callModel,
  classify,
  collectOutput,
  createClient,
  FatalModelError,
  requestBody,
  retryAfterMs,
  TransientModelError,
  UsageLimitError,
  usageLimitFrom,
} from '../src/model.ts'

// ------------------------------------------------------------ helpers

const creds: Credentials = { access: 'access', refresh: 'refresh', expires: Date.now() + 3600_000, accountId: 'acc' }

class FakeTokens extends TokenStore {
  refreshes = 0
  constructor() {
    super({ ...creds }, '/nonexistent/auth.json')
  }
  override async refresh() {
    this.refreshes++
    return creds
  }
}

function sse(events: Record<string, unknown>[]): string {
  return events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join('')
}

const item = { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: '{"findings":[]}' }] }
const completed = {
  type: 'response.completed',
  response: { status: 'completed', output: [], usage: { input_tokens: 2000, input_tokens_details: { cached_tokens: 1500 }, output_tokens: 10, output_tokens_details: { reasoning_tokens: 4 } } },
}
const okEvents = [{ type: 'response.created' }, { type: 'response.output_item.done', output_index: 0, item }, completed]

type Responder = (init: RequestInit) => Response | Promise<Response>

const sseHeaders = { 'content-type': 'text/event-stream', 'x-oai-request-id': 'req_1', 'x-codex-turn-state': 'ts_1' }

const ok: Responder = () => new Response(sse(okEvents), { headers: sseHeaders })

/** A body that sends `text` then runs `then` on the controller. */
function partial(text: string, then: (controller: ReadableStreamDefaultController<Uint8Array>) => void): Responder {
  return () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(text))
          then(controller)
        },
      }),
      { headers: sseHeaders },
    )
}

function fakeFetch(responders: Responder[]) {
  const bodies: string[] = []
  const headers: Headers[] = []
  const fetch = (async (_url: unknown, init: RequestInit) => {
    bodies.push(String(init.body))
    headers.push(new Headers(init.headers))
    const responder = responders.shift()
    if (!responder) throw new Error('no more responses')
    return responder(init)
  }) as typeof globalThis.fetch
  return { fetch, bodies, headers }
}

const request: AgentRequest = {
  instructions: 'review',
  tools: [],
  textFormat: { type: 'json_schema', name: 'x', strict: true, schema: { type: 'object' } },
  promptCacheKey: 'o/r:reviewer',
  sessionId: 'sess',
  input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi' }] }],
}

async function run(responders: Responder[], extra: { signal?: AbortSignal; idleMs?: number; tokens?: FakeTokens } = {}) {
  const tokens = extra.tokens ?? new FakeTokens()
  const fake = fakeFetch(responders)
  const client = createClient(tokens, fake.fetch)
  const retries: { kind: string; delayMs: number; error: string }[] = []
  const promise = callModel(client, request, {
    signal: extra.signal ?? new AbortController().signal,
    tokens,
    backoffMs: [1, 1, 1, 1, 1],
    random: () => 0.5,
    idleMs: extra.idleMs ?? 2000,
    onRetry: info => retries.push(info),
  })
  return { promise, retries, fake }
}

// ------------------------------------------------------------ units

describe('usageLimitFrom', () => {
  it('finds a usage limit in an HTTP error body', () => {
    const limit = usageLimitFrom({ error: { type: 'usage_limit_reached', message: 'limit', resets_at: 1_900_000_000 } })
    assert.ok(limit instanceof UsageLimitError)
    assert.equal(limit.resetsAt, 1_900_000_000_000)
  })
  it('finds a usage limit in a response.failed event', () => {
    const limit = usageLimitFrom({ type: 'response.failed', response: { error: { code: 'usage_not_included', resets_at: 5 } } })
    assert.equal(limit?.resetsAt, 5000)
  })
  it('treats rate_limit_exceeded without resets_at as not a usage limit', () => {
    assert.equal(usageLimitFrom({ error: { code: 'rate_limit_exceeded' } }), undefined)
  })
})

describe('classify', () => {
  const headers = new Headers({ 'retry-after': '7' })
  it('never retries after our abort', () => {
    assert.equal(classify(new APIConnectionError({ message: 'x' }), true).kind, 'abort')
  })
  it('treats connection errors, 5xx, 429 and status-less errors as transient', () => {
    assert.equal(classify(new APIConnectionError({ message: 'x' }), false).kind, 'transient')
    assert.equal(classify(new InternalServerError(503, { message: 'overloaded' }, undefined, headers), false).kind, 'transient')
    assert.equal(classify(new RateLimitError(429, { message: 'slow' }, undefined, headers), false).kind, 'transient')
    assert.equal(classify(new APIError(undefined, { message: 'stream' }, undefined, undefined), false).kind, 'transient')
    assert.equal(classify(new TypeError('terminated'), false).kind, 'transient')
  })
  it('reads retry-after', () => {
    const c = classify(new InternalServerError(503, {}, undefined, headers), false)
    assert.equal(c.kind === 'transient' && c.retryAfterMs, 7000)
    assert.equal(retryAfterMs(new Headers({ 'retry-after-ms': '250' })), 250)
  })
  it('classifies usage limits on 429', () => {
    const c = classify(new RateLimitError(429, { type: 'usage_limit_reached', resets_at: 10 }, undefined, headers), false)
    assert.equal(c.kind, 'usage_limit')
  })
  it('fails on bad requests and context length', () => {
    assert.equal(classify(new APIError(400, { type: 'invalid_request_error' }, 'bad', new Headers()), false).kind, 'fatal')
    assert.equal(classify(new APIError(404, {}, 'nope', new Headers()), false).kind, 'fatal')
    assert.equal(classify(new APIError(undefined, { code: 'context_length_exceeded' }, undefined, undefined), false).kind, 'fatal')
  })
  it('refreshes on 401 and fails on AuthError from the apiKey callback', () => {
    assert.equal(classify(new APIError(401, {}, 'unauth', new Headers()), false).kind, 'auth')
    const wrapped = Object.assign(new Error('Failed to get token'), { cause: new AuthError('login') })
    assert.equal(classify(wrapped, false).kind, 'auth_fatal')
  })
})

describe('backoffDelay', () => {
  it('uses the ladder with ±20% jitter', () => {
    const ladder = [5000, 15000, 30000, 60000, 60000]
    assert.equal(backoffDelay(0, {}, ladder, () => 0), 4000)
    assert.equal(backoffDelay(1, {}, ladder, () => 0.5), 15000)
    assert.equal(backoffDelay(4, {}, ladder, () => 0.999999), 72000)
  })
  it('honours retry-after up to 5 minutes', () => {
    assert.equal(backoffDelay(0, { retryAfterMs: 20_000 }, [1], () => 0.5), 20_000)
    assert.equal(backoffDelay(0, { retryAfterMs: 3_600_000 }, [1], () => 0.5), 300_000)
  })
})

describe('collectOutput', () => {
  it('keeps output_item.done items and fills missing encrypted reasoning', () => {
    const out = collectOutput([{ type: 'reasoning', id: 'r1' }, item], [{ type: 'reasoning', id: 'r1', encrypted_content: 'enc' }])
    assert.equal(out[0]!.encrypted_content, 'enc')
    assert.equal(out[1], item)
  })
  it('falls back to completed.output when nothing streamed', () => {
    assert.deepEqual(collectOutput([], [item]), [item])
  })
})

describe('requestBody', () => {
  it('keeps one developer prefix before appended history without modifying the input', () => {
    const input = [...request.input]
    const req = { ...request, input }
    const first = requestBody(req)
    const toolOutput = { type: 'function_call_output', call_id: 'call_1', output: 'result' }
    input.push(item, toolOutput)

    assert.deepEqual(requestBody(req).input, [...first.input, item, toolOutput])
    assert.deepEqual(input, [...request.input, item, toolOutput])
  })
})

// ------------------------------------------------------------ streams

describe('callModel', () => {
  it('returns output items, usage, request id and turn state', async () => {
    const { promise, fake } = await run([ok])
    const response = await promise
    assert.deepEqual(response.output, [item])
    assert.deepEqual(response.usage, { input: 2000, cached: 1500, output: 10, reasoning: 4 })
    assert.equal(response.requestId, 'req_1')
    assert.equal(response.turnState, 'ts_1')
    const body = JSON.parse(fake.bodies[0]!)
    assert.equal(body.model, 'gpt-6.2-sol')
    assert.equal(Object.hasOwn(body, 'instructions'), false)
    assert.deepEqual(body.input, [
      { role: 'developer', content: [{ type: 'input_text', text: 'review' }] },
      ...request.input,
    ])
    assert.equal(body.store, false)
    assert.equal(body.parallel_tool_calls, false)
    assert.equal(body.prompt_cache_key, 'o/r:reviewer')
    assert.deepEqual(body.reasoning, { effort: 'high', summary: 'auto' })
    assert.equal(fake.headers[0]!.get('session-id'), 'sess')
    assert.equal(fake.headers[0]!.get('chatgpt-account-id'), 'acc')
    assert.equal(fake.headers[0]!.get('authorization'), 'Bearer access')
    assert.equal(fake.headers[0]!.get('openai-organization'), null)
  })

  it('retries a mid-stream drop with an identical body', async () => {
    const drop = partial(sse(okEvents.slice(0, 2)), controller => controller.error(new TypeError('terminated')))
    const { promise, retries, fake } = await run([drop, ok])
    await promise
    assert.equal(retries.length, 1)
    assert.equal(fake.bodies[0], fake.bodies[1])
  })

  it('retries an SSE error event', async () => {
    const error = () => new Response(`event: error\ndata: ${JSON.stringify({ error: { type: 'server_error', message: 'overloaded' } })}\n\n`, { headers: sseHeaders })
    const { promise, retries } = await run([error, ok])
    await promise
    assert.equal(retries.length, 1)
    assert.match(retries[0]!.error, /overloaded/)
  })

  it('retries a type:error event without an error field', async () => {
    const error = () => new Response(`data: ${JSON.stringify({ type: 'error', code: 'server_error', message: 'boom' })}\n\n`, { headers: sseHeaders })
    const { promise, retries } = await run([error, ok])
    await promise
    assert.equal(retries.length, 1)
  })

  it('retries response.failed', async () => {
    const failed = () => new Response(sse([{ type: 'response.failed', response: { error: { code: 'server_error', message: 'x' } } }]), { headers: sseHeaders })
    const { promise, retries } = await run([failed, ok])
    await promise
    assert.equal(retries.length, 1)
  })

  it('fails on response.incomplete without retrying', async () => {
    const incomplete = () => new Response(sse([{ type: 'response.incomplete', response: { incomplete_details: { reason: 'max_output_tokens' } } }]), { headers: sseHeaders })
    const { promise, retries } = await run([incomplete, ok])
    await assert.rejects(promise, FatalModelError)
    assert.equal(retries.length, 0)
  })

  it('retries EOF without response.completed', async () => {
    const eof = () => new Response(sse(okEvents.slice(0, 2)), { headers: sseHeaders })
    const { promise, retries } = await run([eof, ok])
    await promise
    assert.equal(retries.length, 1)
    assert.match(retries[0]!.error, /ended before/)
  })

  it('retries a stalled stream after the idle timeout', async () => {
    const stall = partial(sse(okEvents.slice(0, 1)), () => {})
    const { promise, retries } = await run([stall, ok], { idleMs: 50 })
    await promise
    assert.equal(retries.length, 1)
    assert.match(retries[0]!.error, /no stream event/)
  })

  it('throws UsageLimitError on a 429 usage-limit body without retrying', async () => {
    const limit = () => new Response(JSON.stringify({ error: { type: 'usage_limit_reached', message: 'You have hit your limit', resets_at: 1_900_000_000 } }), { status: 429 })
    const { promise, retries } = await run([limit, ok])
    await assert.rejects(promise, (error: unknown) => error instanceof UsageLimitError && error.resetsAt === 1_900_000_000_000)
    assert.equal(retries.length, 0)
  })

  it('throws UsageLimitError from a stream event', async () => {
    const limit = () => new Response(sse([{ type: 'response.failed', response: { error: { code: 'usage_limit_reached', resets_at: 3 } } }]), { headers: sseHeaders })
    const { promise } = await run([limit])
    await assert.rejects(promise, UsageLimitError)
  })

  it('retries a 503 and honours retry-after-ms', async () => {
    const busy = () => new Response(JSON.stringify({ error: { message: 'overloaded' } }), { status: 503, headers: { 'retry-after-ms': '20' } })
    const { promise, retries } = await run([busy, ok])
    await promise
    assert.equal(retries[0]!.delayMs, 20)
  })

  it('stops on abort mid-stream without retrying', async () => {
    const controller = new AbortController()
    const hang = partial(sse(okEvents.slice(0, 1)), () => setTimeout(() => controller.abort(new Error('run aborted')), 20))
    const { promise, retries } = await run([hang, ok], { signal: controller.signal })
    await assert.rejects(promise, /run aborted/)
    assert.equal(retries.length, 0)
  })

  it('fails on 400 without retrying', async () => {
    const bad = () => new Response(JSON.stringify({ error: { type: 'invalid_request_error', message: 'bad' } }), { status: 400 })
    const { promise, retries } = await run([bad, ok])
    await assert.rejects(promise, FatalModelError)
    assert.equal(retries.length, 0)
  })

  it('refreshes the token once on 401', async () => {
    const tokens = new FakeTokens()
    const unauth = () => new Response(JSON.stringify({ error: { message: 'expired' } }), { status: 401 })
    const { promise } = await run([unauth, ok], { tokens })
    await promise
    assert.equal(tokens.refreshes, 1)
    const again = await run([unauth, unauth, ok], { tokens: new FakeTokens() })
    await assert.rejects(again.promise, AuthError)
  })

  it('gives up after the backoff ladder', async () => {
    const busy = () => new Response('{}', { status: 502 })
    const { promise, retries } = await run([busy, busy, busy, busy, busy, busy, ok])
    await assert.rejects(promise, TransientModelError)
    assert.equal(retries.length, 5)
  })
})
