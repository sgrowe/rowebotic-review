// The agent loop: append-only input, `python` tool calls run in codemode,
// strict JSON final answer, one nudge if the answer is missing.

import { createHash } from 'node:crypto'
import type OpenAI from 'openai'
import type { TokenStore } from './auth.ts'
import type { CodeMode } from './codemode.ts'
import { callModel, modelSettings, type AgentRequest, type Item, type ModelResponse } from './model.ts'
import type { AgentRole, Transcript } from './transcript.ts'

export const PYTHON_TOOL: Item = {
  type: 'function',
  name: 'python',
  description: 'Run Python code in the sandbox. See "The python tool" in the instructions.',
  parameters: {
    type: 'object',
    properties: { code: { type: 'string', description: 'Python code to run.' } },
    required: ['code'],
    additionalProperties: false,
  },
  strict: true,
}

export const NUDGE = 'Finish any checks you have not done, then reply with the final JSON.'

export type AgentSpec = {
  id: string
  role: AgentRole
  security?: boolean
  instructions: string
  promptCacheKey: string
  /** `text.format` json_schema. */
  textFormat: Item
  firstMessage: string
  codemode: Pick<CodeMode, 'run'>
  signal: AbortSignal
  /** Called once, when the first model response completes or fails. */
  onFirstResponse?: () => void
  /**
   * Called with each final JSON answer. `undefined` accepts it; a string is
   * sent as a user message and the agent continues.
   */
  beforeFinish?: (final: unknown, signal: AbortSignal) => Promise<string | undefined>
}

export type ModelCaller = (req: AgentRequest, signal: AbortSignal, onRetry: Parameters<typeof callModel>[2]['onRetry']) => Promise<ModelResponse>

export type AgentDeps = {
  transcript: Transcript
  /** Real calls go through `callModel`; tests pass a fake. */
  model: ModelCaller
}

export function modelCaller(client: OpenAI, tokens: TokenStore): ModelCaller {
  return (req, signal, onRetry) => callModel(client, req, { signal, tokens, onRetry })
}

export class AgentOutputError extends Error {
  override name = 'AgentOutputError'
}

export function userMessage(text: string): Item {
  return { role: 'user', content: [{ type: 'input_text', text }] }
}

/** Text of the last assistant message item. */
export function finalText(output: Item[]): string {
  const messages = output.filter(item => item.type === 'message')
  const last = messages.at(-1)
  if (!last) return ''
  return (last.content ?? [])
    .filter((part: Item) => part.type === 'output_text')
    .map((part: Item) => part.text)
    .join('')
}

function firstLine(code: string): string {
  const line = code.split('\n').find(l => l.trim() && !l.trim().startsWith('import ')) ?? ''
  return line.length > 80 ? `${line.slice(0, 77)}...` : line
}

export function instructionsHash(instructions: string): string {
  return createHash('sha256').update(instructions).digest('hex').slice(0, 16)
}

export async function runAgent(spec: AgentSpec, deps: AgentDeps): Promise<unknown> {
  const { transcript } = deps
  const tools = [PYTHON_TOOL]
  // session-id steers Codex routing: agents that share a cache key must share
  // it too, or a new agent's first request misses (spike 5: 0/6 vs 5/6 hits).
  const sessionId = spec.promptCacheKey
  const input: Item[] = [userMessage(spec.firstMessage)]
  let turnState: string | undefined
  let turn = 0
  let nudged = false
  let firstResponseSeen = false
  const firstResponse = () => {
    if (firstResponseSeen) return
    firstResponseSeen = true
    spec.onFirstResponse?.()
  }

  const settings = modelSettings(spec.security)
  if (settings.access_programs) transcript.log(spec.id, `using ${settings.model} with Daybreak Blue`)
  transcript.addAgent(spec.id, spec.role)
  transcript.write('agent_start', spec.id, {
    role: spec.role,
    ...settings,
    instructionsHash: instructionsHash(spec.instructions),
    instructionsChars: spec.instructions.length,
    promptCacheKey: spec.promptCacheKey,
    sessionId,
    tools: tools.map(tool => tool.name),
  })
  transcript.write('request', spec.id, { turn: 1, items: input })

  try {
    while (true) {
      spec.signal.throwIfAborted()
      turn++
      let response: ModelResponse
      try {
        response = await deps.model(
          {
            instructions: spec.instructions,
            security: spec.security,
            tools,
            textFormat: spec.textFormat,
            promptCacheKey: spec.promptCacheKey,
            sessionId,
            input,
            turnState,
          },
          spec.signal,
          info => transcript.retry(spec.id, info),
        )
      } finally {
        firstResponse()
      }
      turnState = response.turnState ?? turnState
      transcript.response({
        agentId: spec.id,
        turn,
        usage: response.usage,
        durationMs: response.durationMs,
        promptCacheKey: spec.promptCacheKey,
        sessionId,
        requestId: response.requestId,
        requestBytes: response.requestBytes,
        output: response.output,
      })
      input.push(...response.output)

      const calls = response.output.filter(item => item.type === 'function_call')
      if (calls.length > 0) {
        const results: Item[] = []
        for (const call of calls) {
          results.push({ type: 'function_call_output', call_id: call.call_id, output: await runCall(spec, transcript, turn, call) })
        }
        input.push(...results)
        transcript.write('request', spec.id, { turn: turn + 1, items: results })
        continue
      }

      const text = finalText(response.output).trim()
      let parsed: unknown
      try {
        parsed = text ? JSON.parse(text) : undefined
      } catch {
        parsed = undefined
      }
      if (parsed !== undefined && parsed !== null && typeof parsed === 'object') {
        const wake = await spec.beforeFinish?.(parsed, spec.signal)
        if (wake === undefined) {
          transcript.write('agent_end', spec.id, { ok: true, final: parsed, totals: transcript.totals(spec.id) })
          return parsed
        }
        transcript.log(spec.id, 'final answer not accepted yet; continuing')
        const message = userMessage(wake)
        input.push(message)
        transcript.write('request', spec.id, { turn: turn + 1, items: [message], wake: true })
        continue
      }
      if (nudged) throw new AgentOutputError(text ? `final answer is not JSON: ${text.slice(0, 200)}` : 'empty final answer')
      nudged = true
      transcript.log(spec.id, text ? 'final answer is not JSON; asking again' : 'empty final answer; asking again')
      const nudge = userMessage(NUDGE)
      input.push(nudge)
      transcript.write('request', spec.id, { turn: turn + 1, items: [nudge], nudge: true })
    }
  } catch (error) {
    const reason = spec.signal.aborted ? (spec.signal.reason ?? error) : error
    transcript.write('agent_end', spec.id, { ok: false, error: describeError(reason), totals: transcript.totals(spec.id) })
    throw reason
  }
}

async function runCall(spec: AgentSpec, transcript: Transcript, turn: number, call: Item): Promise<string> {
  spec.signal.throwIfAborted()
  if (call.name !== PYTHON_TOOL.name) return `Unknown tool ${call.name}. The only tool is ${PYTHON_TOOL.name}.`
  let code: string
  try {
    code = String(JSON.parse(call.arguments ?? '{}').code ?? '')
  } catch {
    return 'Tool arguments were not valid JSON. Call python with {"code": "..."}.'
  }
  const result = await spec.codemode.run(code)
  transcript.write('code_exec', spec.id, {
    turn,
    callId: call.call_id,
    code,
    output: result.output,
    error: result.error ?? null,
    reset: result.reset ?? false,
    calls: result.calls,
    durationMs: result.durationMs,
  })
  const status = result.error ? ` error: ${result.error.split('\n').findLast(l => l.trim()) ?? ''}` : ''
  transcript.log(spec.id, `python: ${firstLine(code)} → ${result.calls.length} calls ${(result.durationMs / 1000).toFixed(1)}s${status}`)
  return result.output
}

export function describeError(error: unknown): string {
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timed out'
  if (error instanceof Error) return `${error.name}: ${error.message}`
  return String(error)
}
