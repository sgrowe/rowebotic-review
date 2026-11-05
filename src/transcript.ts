// JSONL transcript per run, cache metrics, and the stdout log lines.

import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Usage } from './model.ts'

export type AgentRole = 'orchestrator' | 'reviewer'

export type Totals = {
  turns: number
  input: number
  cached: number
  output: number
  reasoning: number
  durationMs: number
  retries: number
  cacheMisses: number
}

export type AgentTotals = Totals & {
  /** Reviewer turn 1 vs later turns: measures the stagger + shared key. */
  first: { input: number; cached: number }
  later: { input: number; cached: number }
}

const emptyTotals = (): Totals => ({ turns: 0, input: 0, cached: 0, output: 0, reasoning: 0, durationMs: 0, retries: 0, cacheMisses: 0 })

const emptyAgentTotals = (): AgentTotals => ({ ...emptyTotals(), first: { input: 0, cached: 0 }, later: { input: 0, cached: 0 } })

export function hitRate(cached: number, input: number): number {
  return input > 0 ? cached / input : 0
}

export function pct(cached: number, input: number): string {
  return input > 0 ? `${Math.round(100 * hitRate(cached, input))}%` : '-'
}

export function kilo(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

/** A cache miss: fewer tokens cached than the previous request's whole input (minus slack). */
export function isCacheMiss(cached: number, previousInput: number | undefined): boolean {
  return previousInput !== undefined && cached < previousInput - 1024
}

type AgentState = { role: AgentRole; totals: AgentTotals; lastInput?: number; lastEnd?: number }

export type ResponseInfo = {
  agentId: string
  turn: number
  usage: Usage
  durationMs: number
  promptCacheKey: string
  sessionId: string
  requestId: string | null
  requestBytes: number
  output: unknown[]
}

export class Transcript {
  readonly path: string
  readonly agents = new Map<string, AgentState>()
  #print: (line: string) => void

  constructor(path: string, print: (line: string) => void = line => console.log(line)) {
    this.path = path
    this.#print = print
    mkdirSync(dirname(path), { recursive: true })
  }

  write(type: string, agentId: string, data: Record<string, unknown> = {}): void {
    // Sync append: records stay ordered and survive a crash.
    appendFileSync(this.path, `${JSON.stringify({ ts: new Date().toISOString(), type, agentId, ...data })}\n`)
  }

  log(agentId: string, text: string): void {
    const time = new Date().toLocaleTimeString('en-GB', { hour12: false })
    this.#print(`${time} [${agentId}] ${text}`)
  }

  addAgent(agentId: string, role: AgentRole): void {
    this.agents.set(agentId, { role, totals: emptyAgentTotals() })
  }

  /** Records a `response` (and maybe a `cache_miss`) and prints the turn line. */
  response(info: ResponseInfo): void {
    const state = this.agents.get(info.agentId) ?? { role: 'reviewer' as const, totals: emptyAgentTotals() }
    this.agents.set(info.agentId, state)
    const { usage } = info
    const now = Date.now()
    const gapMs = state.lastEnd === undefined ? null : now - info.durationMs - state.lastEnd
    const hit = hitRate(usage.cached, usage.input)
    this.write('response', info.agentId, {
      turn: info.turn,
      ...usage,
      hit,
      durationMs: info.durationMs,
      gapMs,
      promptCacheKey: info.promptCacheKey,
      sessionId: info.sessionId,
      requestId: info.requestId,
      requestBytes: info.requestBytes,
      output: info.output,
    })
    const missed = isCacheMiss(usage.cached, state.lastInput)
    if (missed) {
      state.totals.cacheMisses++
      this.write('cache_miss', info.agentId, { turn: info.turn, previousInput: state.lastInput, input: usage.input, cached: usage.cached, gapMs })
    }
    const t = state.totals
    t.turns++
    t.input += usage.input
    t.cached += usage.cached
    t.output += usage.output
    t.reasoning += usage.reasoning
    t.durationMs += info.durationMs
    const bucket = info.turn === 1 ? t.first : t.later
    bucket.input += usage.input
    bucket.cached += usage.cached
    state.lastInput = usage.input
    state.lastEnd = now
    this.log(
      info.agentId,
      `turn ${info.turn} in ${kilo(usage.input)} cached ${kilo(usage.cached)} (${pct(usage.cached, usage.input)}) out ${kilo(usage.output)} ${(info.durationMs / 1000).toFixed(1)}s${missed ? ' CACHE MISS' : ''}`,
    )
  }

  retry(agentId: string, data: { attempt: number; delayMs: number; kind: string; error: string }): void {
    const state = this.agents.get(agentId)
    if (state) state.totals.retries++
    this.write('retry', agentId, data)
    this.log(agentId, `retry ${data.attempt} in ${(data.delayMs / 1000).toFixed(0)}s (${data.kind}): ${data.error}`)
  }

  totals(agentId: string): AgentTotals {
    return this.agents.get(agentId)?.totals ?? emptyAgentTotals()
  }

  /** Run totals per role, and overall. */
  runTotals(): Record<AgentRole | 'all', AgentTotals> {
    const out = { orchestrator: emptyAgentTotals(), reviewer: emptyAgentTotals(), all: emptyAgentTotals() }
    for (const { role, totals } of this.agents.values()) {
      for (const target of [out[role], out.all]) {
        for (const key of ['turns', 'input', 'cached', 'output', 'reasoning', 'durationMs', 'retries', 'cacheMisses'] as const) {
          target[key] += totals[key]
        }
        target.first.input += totals.first.input
        target.first.cached += totals.first.cached
        target.later.input += totals.later.input
        target.later.cached += totals.later.cached
      }
    }
    return out
  }

  /** Per-agent cache table for stdout. */
  summaryLines(): string[] {
    const lines = ['agent                     turns   input  cached   hit  t1 hit  t2+ hit  misses retries']
    const row = (name: string, t: AgentTotals) =>
      `${name.padEnd(24)} ${String(t.turns).padStart(6)} ${kilo(t.input).padStart(7)} ${kilo(t.cached).padStart(7)} ${pct(t.cached, t.input).padStart(5)} ${pct(t.first.cached, t.first.input).padStart(7)} ${pct(t.later.cached, t.later.input).padStart(8)} ${String(t.cacheMisses).padStart(7)} ${String(t.retries).padStart(7)}`
    for (const [id, { totals }] of this.agents) lines.push(row(id, totals))
    const run = this.runTotals()
    lines.push(row('= orchestrator', run.orchestrator), row('= reviewers', run.reviewer), row('= all', run.all))
    return lines
  }
}
