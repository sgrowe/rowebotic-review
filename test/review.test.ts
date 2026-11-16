import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Monty } from '@pydantic/monty'
import type { Concern } from '../src/config.ts'
import type { McpServer, McpServers } from '../src/mcp.ts'
import { UsageLimitError } from '../src/model.ts'
import { type ChildRun, createReviewFunction, type Finding, reviewStub, startReviewResources, transcriptFile } from '../src/review.ts'

const concerns: Concern[] = [
  { name: 'design', description: 'd', when: 'always', body: 'design body' },
  { name: 'bugs', description: 'b', when: 'always', body: 'bugs body' },
]

const finding: Finding = { file: 'a.ts', line: 1, severity: 'minor', summary: 's', evidence: 'e', scenario: null }

function setup(runChild: (child: ChildRun, events: string[]) => Promise<Finding[]>, timeoutMs = 10_000) {
  const events: string[] = []
  const stopped: unknown[] = []
  const fn = createReviewFunction({
    concerns,
    timeoutMs,
    runChild: child => runChild(child, events),
    log: () => {},
    stopRun: error => stopped.push(error),
  })
  return { fn, events, stopped }
}

const args = (key: string, concern = 'bugs') => ({ key, concern, scope: 'all', intent: 'i' })

it('closes MCP servers when the Monty pool fails to start', async () => {
  const closed: string[] = []
  const server = (name: string) => ({ close: async () => { closed.push(name) } }) as McpServer
  const servers: McpServers = { jj: server('jj'), psql: server('psql'), github: server('github') }
  const failure = new Error('pool startup failed')
  await assert.rejects(
    startReviewResources(async () => servers, async (): Promise<Monty> => { throw failure }),
    error => error === failure,
  )
  assert.deepEqual(closed.sort(), ['github', 'jj', 'psql'])
})

describe('reviewStub', () => {
  it('types concern as str and lists the names in the docstring', () => {
    const stub = reviewStub(concerns)
    assert.match(stub, /concern: str,/)
    assert.match(stub, /concern: the concern to review, one of: "bugs", "design"\./)
  })
})

describe('createReviewFunction', () => {
  it('starts the first reviewer at once and the rest after its first response', async () => {
    const t = setup(async (child, events) => {
      events.push(`start ${child.id}`)
      if (child.id === 'a') {
        await sleep(30)
        events.push('a first response')
        child.onFirstResponse()
      }
      await sleep(10)
      return [finding]
    })
    const signal = new AbortController().signal
    const results = await Promise.all([t.fn.call(args('a'), signal), t.fn.call(args('b'), signal), t.fn.call(args('c', 'design'), signal)])
    assert.deepEqual(t.events, ['start a', 'a first response', 'start b', 'start c'])
    assert.deepEqual(results.map(r => r), [
      { key: 'a', ok: true, findings: [finding], error: null },
      { key: 'b', ok: true, findings: [finding], error: null },
      { key: 'c', ok: true, findings: [finding], error: null },
    ])
  })

  it('opens the gate when the first reviewer fails before responding', async () => {
    const t = setup(async (child, events) => {
      events.push(`start ${child.id}`)
      if (child.id === 'a') throw new Error('boom')
      return []
    })
    const signal = new AbortController().signal
    const [a, b] = await Promise.all([t.fn.call(args('a'), signal), t.fn.call(args('b'), signal)])
    assert.deepEqual(a, { key: 'a', ok: false, findings: [], error: 'Error: boom' })
    assert.equal((b as { ok: boolean }).ok, true)
  })

  it('never raises: unknown concern, timeout and abort while waiting', async () => {
    const t = setup(async child => {
      await new Promise((_, reject) => {
        if (child.signal.aborted) reject(child.signal.reason)
        child.signal.addEventListener('abort', () => reject(child.signal.reason))
      })
      return []
    }, 20)
    const controller = new AbortController()
    assert.deepEqual(await t.fn.call(args('x', 'nope'), controller.signal), { key: 'x', ok: false, findings: [], error: 'unknown concern nope; use one of: bugs, design' })
    const first = t.fn.call(args('a'), controller.signal)
    const waiting = t.fn.call(args('b'), controller.signal)
    assert.deepEqual(await first, { key: 'a', ok: false, findings: [], error: 'timed out after 0 min' })
    // Aborting the orchestrator ends a queued or running reviewer with ok=false.
    controller.abort(new Error('run stopped'))
    const b = (await waiting) as { ok: boolean; error: string }
    assert.equal(b.ok, false)
  })

  it('stops the run on a usage limit', async () => {
    const limit = new UsageLimitError('limit', 1)
    const t = setup(async () => {
      throw limit
    })
    const result = (await t.fn.call(args('a'), new AbortController().signal)) as { ok: boolean }
    assert.equal(result.ok, false)
    assert.deepEqual(t.stopped, [limit])
  })

  it('gives duplicate keys unique agent ids', async () => {
    const ids: string[] = []
    const t = setup(async child => {
      ids.push(child.id)
      child.onFirstResponse()
      return []
    })
    const signal = new AbortController().signal
    await t.fn.call(args('bugs'), signal)
    await t.fn.call(args('bugs'), signal)
    assert.deepEqual(ids, ['bugs', 'bugs#2'])
  })
})

describe('transcriptFile', () => {
  it('names the file by time, repo, PR and run id', () => {
    const path = transcriptFile({ owner: 'o', name: 'r' }, 12, 'abcd1234', new Date('2026-11-05T12:00:00.000Z'))
    assert.match(path, /\.rowebotic-review\/sessions\/2026-11-05T12-00-00-000Z_o-r_pr12_abcd1234\.jsonl$/)
  })
})
