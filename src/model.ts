// Codex Responses API over HTTP SSE: one streamed call, an error classifier,
// and one retry loop that owns every retry (the SDK's own retries are off).

import { setTimeout as sleep } from 'node:timers/promises'
import OpenAI, { APIConnectionError, APIError, APIUserAbortError } from 'openai'
import { AuthError, type TokenStore } from './auth.ts'

export const MODEL = 'gpt-6.2-sol'
export const REASONING_EFFORT = 'high'
export const CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex'
export const IDLE_TIMEOUT_MS = 5 * 60 * 1000
export const BACKOFF_MS = [5_000, 15_000, 30_000, 60_000, 60_000]
export const MAX_RETRY_AFTER_MS = 5 * 60 * 1000

export type Item = Record<string, any>

export type Usage = { input: number; cached: number; output: number; reasoning: number }

export type AgentRequest = {
  instructions: string
  security?: boolean
  tools: Item[]
  textFormat: Item
  promptCacheKey: string
  sessionId: string
  input: Item[]
  /** Last `x-codex-turn-state` this agent received; echoed for sticky routing. */
  turnState?: string
}

export type ModelResponse = {
  output: Item[]
  usage: Usage
  requestId: string | null
  turnState: string | null
  durationMs: number
  requestBytes: number
  status: string | undefined
}

export function modelSettings(security = false) {
  return security
    ? { model: 'gpt-6-sol', access_programs: { cyber: 'daybreak_blue' } }
    : { model: MODEL }
}

export function requestBody(req: AgentRequest): Item {
  return {
    ...modelSettings(req.security),
    // The model caches reusable instructions when they start the input prefix.
    input: [
      { role: 'developer', content: [{ type: 'input_text', text: req.instructions }] },
      ...req.input,
    ],
    tools: req.tools,
    tool_choice: 'auto',
    parallel_tool_calls: false,
    reasoning: { effort: REASONING_EFFORT, summary: 'auto' },
    store: false,
    stream: true,
    include: ['reasoning.encrypted_content'],
    prompt_cache_key: req.promptCacheKey,
    text: { format: req.textFormat, verbosity: 'low' },
  }
}

export function createClient(tokens: TokenStore, fetchImpl?: typeof fetch): OpenAI {
  return new OpenAI({
    apiKey: () => tokens.accessToken(),
    baseURL: CODEX_BASE_URL,
    organization: null,
    project: null,
    maxRetries: 0,
    // The idle timer bounds each attempt; this is only a backstop.
    timeout: 60 * 60 * 1000,
    fetch: fetchImpl,
    defaultHeaders: {
      'chatgpt-account-id': tokens.accountId,
      originator: 'rowebotic-review',
      'OpenAI-Beta': 'responses=experimental',
    },
  })
}

// ---------------------------------------------------------------- errors

/** Transient model failure without an SDK error: idle stall, EOF, failed event. */
export class TransientModelError extends Error {
  override name = 'TransientModelError'
}

/** Non-retryable model failure: bad request, context too long, incomplete response. */
export class FatalModelError extends Error {
  override name = 'FatalModelError'
}

/** ChatGPT plan usage limit. The run stops; the watcher waits until `resetsAt`. */
export class UsageLimitError extends Error {
  override name = 'UsageLimitError'
  readonly resetsAt: number | undefined
  constructor(message: string, resetsAt: number | undefined) {
    super(message)
    this.resetsAt = resetsAt
  }
}

const USAGE_LIMIT_CODES = new Set(['usage_limit_reached', 'usage_not_included', 'rate_limit_exceeded'])
const FATAL_CODES = new Set([
  'context_length_exceeded', 'invalid_request_error', 'invalid_prompt',
  'invalid_access_program', 'model_not_found',
])

/** Finds a usage limit in an error body/event: `{code|type, resets_at}` at any nesting of `error`. */
export function usageLimitFrom(body: unknown): UsageLimitError | undefined {
  let current = body as Item | undefined
  for (let depth = 0; current && typeof current === 'object' && depth < 4; depth++) {
    const code = current.code ?? current.type
    if (typeof code === 'string' && USAGE_LIMIT_CODES.has(code)) {
      const resetsAt = Number(current.resets_at)
      const hasReset = Number.isFinite(resetsAt) && resetsAt > 0
      // A plain rate limit without a reset time is transient.
      if (code === 'rate_limit_exceeded' && !hasReset) return undefined
      return new UsageLimitError(String(current.message ?? code), hasReset ? resetsAt * 1000 : undefined)
    }
    current = current.error ?? current.response?.error
  }
  return undefined
}

function errorCode(body: unknown): string | undefined {
  let current = body as Item | undefined
  for (let depth = 0; current && typeof current === 'object' && depth < 4; depth++) {
    for (const value of [current.code, current.type]) {
      if (typeof value === 'string' && value !== 'error') return value
    }
    current = current.error ?? current.response?.error
  }
  return undefined
}

export type Classified =
  | { kind: 'abort' }
  | { kind: 'transient'; message: string; retryAfterMs?: number }
  | { kind: 'usage_limit'; error: UsageLimitError }
  | { kind: 'auth'; message: string }
  | { kind: 'auth_fatal'; error: AuthError }
  | { kind: 'fatal'; message: string }
  /** Codex's cybersecurity filter flagged the request. A retry sometimes passes; more rarely do. */
  | { kind: 'content_flag'; message: string }

const CONTENT_FLAG = /flagged for possible cybersecurity risk/i
export const CONTENT_FLAG_RETRIES = 1

export function retryAfterMs(headers: Headers | undefined | null): number | undefined {
  if (!headers) return undefined
  const ms = Number(headers.get('retry-after-ms'))
  if (headers.get('retry-after-ms') !== null && Number.isFinite(ms)) return Math.max(0, ms)
  const value = headers.get('retry-after')
  if (value === null) return undefined
  const seconds = Number(value)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(value)
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now())
}

function message(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

/** `aborted`: our run/agent signal fired, so never retry. */
export function classify(error: unknown, aborted: boolean): Classified {
  if (aborted) return { kind: 'abort' }
  if (error instanceof UsageLimitError) return { kind: 'usage_limit', error }
  if (CONTENT_FLAG.test(message(error))) return { kind: 'content_flag', message: message(error) }
  if (error instanceof FatalModelError) return { kind: 'fatal', message: error.message }
  if (error instanceof TransientModelError) return { kind: 'transient', message: error.message }
  // The SDK wraps errors thrown by the apiKey callback in OpenAIError.
  const cause = (error as { cause?: unknown })?.cause
  if (error instanceof AuthError) return { kind: 'auth_fatal', error }
  if (cause instanceof AuthError) return { kind: 'auth_fatal', error: cause }
  if (error instanceof APIUserAbortError) return { kind: 'transient', message: message(error) }
  if (error instanceof APIConnectionError) return { kind: 'transient', message: message(error) }
  if (error instanceof APIError) {
    const body = error.error
    const limit = usageLimitFrom(body)
    if (limit) return { kind: 'usage_limit', error: limit }
    const code = errorCode(body) ?? error.code ?? error.type ?? undefined
    if (code && FATAL_CODES.has(code)) return { kind: 'fatal', message: message(error) }
    const status = error.status
    if (status === 401) return { kind: 'auth', message: message(error) }
    if (status === undefined || status === 408 || status === 409 || status === 429 || status >= 500) {
      return { kind: 'transient', message: message(error), retryAfterMs: retryAfterMs(error.headers) }
    }
    return { kind: 'fatal', message: message(error) }
  }
  // undici `TypeError: terminated`, socket resets, JSON parse of a cut frame, ...
  return { kind: 'transient', message: message(error) }
}

// ---------------------------------------------------------------- one call

function usageOf(response: Item | undefined): Usage {
  const usage = response?.usage
  return {
    input: usage?.input_tokens ?? 0,
    cached: usage?.input_tokens_details?.cached_tokens ?? 0,
    output: usage?.output_tokens ?? 0,
    reasoning: usage?.output_tokens_details?.reasoning_tokens ?? 0,
  }
}

/** Output items from `output_item.done`, with `completed.output` as a fallback and filler. */
export function collectOutput(done: Item[], completedOutput: Item[] | undefined): Item[] {
  const items = done.filter(Boolean)
  if (!completedOutput?.length) return items
  if (items.length === 0) return completedOutput
  const byId = new Map(completedOutput.filter(item => item.id).map(item => [item.id, item]))
  return items.map(item => {
    if (item.type === 'reasoning' && !item.encrypted_content && byId.get(item.id)?.encrypted_content) {
      return { ...item, encrypted_content: byId.get(item.id)!.encrypted_content }
    }
    return item
  })
}

/** One streamed request. Throws on any failure; `callModel` decides on retries. */
export async function streamOnce(client: OpenAI, req: AgentRequest, signal: AbortSignal, idleMs = IDLE_TIMEOUT_MS): Promise<ModelResponse> {
  const start = Date.now()
  const body = requestBody(req)
  const requestBytes = Buffer.byteLength(JSON.stringify(body))
  const attempt = new AbortController()
  let idle = false
  let timer: NodeJS.Timeout | undefined
  const touch = () => {
    clearTimeout(timer)
    timer = setTimeout(() => {
      idle = true
      attempt.abort(new TransientModelError('idle timeout'))
    }, idleMs)
  }
  const combined = AbortSignal.any([signal, attempt.signal])
  const headers: Record<string, string> = { 'session-id': req.sessionId }
  if (req.turnState) headers['x-codex-turn-state'] = req.turnState
  const done: Item[] = []
  let completed: Item | undefined
  let requestId: string | null = null
  let turnState: string | null = null
  touch()
  try {
    const { data: stream, response } = await client.responses
      .create(body as unknown as OpenAI.Responses.ResponseCreateParamsStreaming, { headers, signal: combined })
      .withResponse()
    requestId = response.headers.get('x-oai-request-id') ?? response.headers.get('x-request-id')
    turnState = response.headers.get('x-codex-turn-state')
    touch()
    for await (const event of stream as AsyncIterable<Item>) {
      touch()
      switch (event.type) {
        case 'response.output_item.done':
          done[event.output_index ?? done.length] = event.item
          break
        case 'response.completed':
        case 'response.done':
          completed = event.response ?? {}
          break
        case 'response.incomplete': {
          const reason = event.response?.incomplete_details?.reason ?? 'unknown reason'
          throw new FatalModelError(`response incomplete: ${reason}`)
        }
        case 'response.failed': {
          const error = event.response?.error
          const limit = usageLimitFrom(event)
          if (limit) throw limit
          const text = `response failed: ${error?.code ?? ''} ${error?.message ?? JSON.stringify(event.response?.error ?? {})}`
          if (error?.code && FATAL_CODES.has(error.code)) throw new FatalModelError(text)
          throw new TransientModelError(text)
        }
        case 'error': {
          const limit = usageLimitFrom(event)
          if (limit) throw limit
          const code = errorCode(event)
          const text = `stream error: ${code ?? ''} ${event.message ?? event.error?.message ?? JSON.stringify(event)}`
          if (code && FATAL_CODES.has(code)) throw new FatalModelError(text)
          throw new TransientModelError(text)
        }
      }
      if (completed) break
    }
  } catch (error) {
    if (signal.aborted) throw signal.reason ?? error
    if (idle) throw new TransientModelError(`no stream event for ${idleMs / 1000}s`)
    throw error
  } finally {
    clearTimeout(timer)
  }
  // The SDK ends the iterator silently when aborted.
  if (signal.aborted) throw signal.reason ?? new Error('aborted')
  if (idle) throw new TransientModelError(`no stream event for ${idleMs / 1000}s`)
  if (!completed) throw new TransientModelError('stream ended before response.completed')
  const reportedProgram = completed.access_programs?.cyber
  if (req.security && reportedProgram !== undefined && reportedProgram !== 'daybreak_blue') {
    throw new FatalModelError(`Expected Daybreak Blue. Provider reported ${reportedProgram}`)
  }
  return {
    output: collectOutput(done, completed.output),
    usage: usageOf(completed),
    requestId,
    turnState,
    durationMs: Date.now() - start,
    requestBytes,
    status: completed.status,
  }
}

// ---------------------------------------------------------------- retry loop

export type RetryInfo = { attempt: number; delayMs: number; kind: string; error: string }

export type CallOptions = {
  signal: AbortSignal
  tokens?: TokenStore
  onRetry?: (info: RetryInfo) => void
  backoffMs?: number[]
  idleMs?: number
  /** Jitter source in [0, 1); tests pass a constant. */
  random?: () => number
}

export function backoffDelay(attempt: number, classified: { retryAfterMs?: number }, backoff: number[], random: () => number): number {
  if (classified.retryAfterMs !== undefined) return Math.min(classified.retryAfterMs, MAX_RETRY_AFTER_MS)
  const base = backoff[Math.min(attempt, backoff.length - 1)]!
  return Math.round(base * (0.8 + 0.4 * random()))
}

/** Streamed call with retries. The input is never changed between attempts. */
export async function callModel(client: OpenAI, req: AgentRequest, options: CallOptions): Promise<ModelResponse> {
  const backoff = options.backoffMs ?? BACKOFF_MS
  const random = options.random ?? Math.random
  let retries = 0
  let flagRetries = 0
  let refreshedAuth = false
  while (true) {
    try {
      return await streamOnce(client, req, options.signal, options.idleMs)
    } catch (error) {
      const classified = classify(error, options.signal.aborted)
      switch (classified.kind) {
        case 'abort':
          throw options.signal.reason ?? error
        case 'usage_limit':
          throw classified.error
        case 'auth_fatal':
          throw classified.error
        case 'fatal':
          throw new FatalModelError(classified.message)
        case 'auth': {
          if (refreshedAuth || !options.tokens) throw new AuthError(`Codex rejected the token: ${classified.message}`)
          refreshedAuth = true
          options.onRetry?.({ attempt: retries + 1, delayMs: 0, kind: 'auth', error: classified.message })
          try {
            await options.tokens.refresh()
          } catch (refreshError) {
            if (refreshError instanceof AuthError) throw refreshError
            throw new AuthError(`Token refresh failed: ${message(refreshError)}`)
          }
          continue
        }
        case 'content_flag': {
          if (flagRetries >= CONTENT_FLAG_RETRIES) {
            throw new FatalModelError(`flagged by the cybersecurity filter after ${flagRetries} ${flagRetries === 1 ? 'retry' : 'retries'}: ${classified.message}`)
          }
          flagRetries++
          const delayMs = backoffDelay(0, {}, backoff, random)
          options.onRetry?.({ attempt: flagRetries, delayMs, kind: 'content_flag', error: classified.message })
          try {
            await sleep(delayMs, undefined, { signal: options.signal })
          } catch {
            throw options.signal.reason ?? error
          }
          continue
        }
        case 'transient': {
          if (retries >= backoff.length) {
            throw new TransientModelError(`gave up after ${retries} retries: ${classified.message}`)
          }
          const delayMs = backoffDelay(retries, classified, backoff, random)
          retries++
          options.onRetry?.({ attempt: retries, delayMs, kind: 'transient', error: classified.message })
          try {
            await sleep(delayMs, undefined, { signal: options.signal })
          } catch {
            throw options.signal.reason ?? error
          }
        }
      }
    }
  }
}
