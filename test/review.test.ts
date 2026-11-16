import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Monty } from '@pydantic/monty'
import type { Concern } from '../src/config.ts'
import type { McpServer, McpServers } from '../src/mcp.ts'
import { UsageLimitError } from '../src/model.ts'
import { batchPoolCapacity, PR_START_INTERVAL_MS, type ChildRun, createReviewRunner, type Finding, createReviewBatchTool, runBatch, startReviewResources, transcriptFile } from '../src/review.ts'

const concerns: Concern[] = [
  { name: 'design', description: 'd', when: 'always', body: 'design body' },
  { name: 'bugs', description: 'b', when: 'always', body: 'bugs body' },
]

const finding: Finding = { file: 'a.ts', line: 1, severity: 'minor', summary: 's', evidence: 'e', scenario: null }

function setup(runChild: (child: ChildRun, events: string[]) => Promise<Finding[]>, timeoutMs = 10_000) {
  const events: string[] = []
  const stopped: unknown[] = []
  const runner = createReviewRunner({
    concerns,
    timeoutMs,
    runChild: child => runChild(child, events),
    log: () => {},
    stopRun: error => stopped.push(error),
  })
  return { fn: { call: runner }, events, stopped }
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

describe('createReviewRunner', () => {
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


describe('batch lifecycle', () => {
  it('prepares once, shares resources, and waits for peers and cleanup after a failure', async () => {
    const events: string[] = []
    const shared = {}
    let finishPeer!: () => void
    let finishClose!: () => void
    const peer = new Promise<void>(resolve => { finishPeer = resolve })
    const closing = new Promise<void>(resolve => { finishClose = resolve })
    let settled = false
    const batch = runBatch([1, 2], {
      wait: async () => {},
      prepare: async () => { events.push('prepare') },
      start: async () => { events.push('start'); return shared },
      review: async (number, resources) => {
        assert.equal(resources, shared)
        events.push(`review ${number}`)
        if (number === 1) throw new Error('first failed')
        await peer
        events.push('peer finished')
        return number
      },
      close: async resources => {
        assert.equal(resources, shared)
        events.push('close')
        await closing
      },
    }).then(results => { settled = true; return results })
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(events, ['prepare', 'start', 'review 1', 'review 2'])
    assert.equal(settled, false)
    finishPeer()
    await new Promise(resolve => setImmediate(resolve))
    assert.deepEqual(events.slice(-2), ['peer finished', 'close'])
    assert.equal(settled, false)
    finishClose()
    const results = await batch
    assert.equal(results[0]!.status, 'rejected')
    assert.deepEqual(results[1], { status: 'fulfilled', value: 2 })
  })

  it('does not start resources after preparation fails or for empty batches', async () => {
    let starts = 0
    const lifecycle = {
      prepare: async () => { throw new Error('fetch failed') },
      start: async () => { starts++; return {} },
      review: async () => 1,
      close: async () => {},
    }
    assert.deepEqual(await runBatch([], lifecycle), [])
    await assert.rejects(runBatch([1], lifecycle), /fetch failed/)
    assert.equal(starts, 0)
  })
})

it('scales pool capacity up to sixty workers', () => {
  assert.equal(batchPoolCapacity(1), 9)
  assert.equal(batchPoolCapacity(6), 54)
  assert.equal(batchPoolCapacity(7), 60)
  assert.equal(batchPoolCapacity(10), 60)
})

it('starts immediately then spaces overlapping PRs two seconds apart in selection order', async () => {
  let now = 0
  const starts: number[] = []
  const times: number[] = []
  const releases: (() => void)[] = []
  const delays: number[] = []
  let finishFirst!: () => void
  const first = new Promise<void>(resolve => { finishFirst = resolve })
  const batch = runBatch([1, 2, 3], {
    prepare: async () => {}, start: async () => ({}), close: async () => {},
    wait: async ms => { delays.push(ms); await new Promise<void>(resolve => { releases.push(() => { now += ms; resolve() }) }) },
    review: async item => { starts.push(item); times.push(now); if (item === 1) await first; if (item === 2) throw new Error('failed'); return item },
  })
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(starts, [1])
  releases.shift()!()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(starts, [1, 2])
  releases.shift()!()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(starts, [1, 2, 3])
  assert.deepEqual(times, [0, 2000, 4000])
  assert.deepEqual(delays, [PR_START_INTERVAL_MS, PR_START_INTERVAL_MS])
  finishFirst()
  assert.deepEqual((await batch).map(r => r.status), ['fulfilled', 'rejected', 'fulfilled'])
})

it('aborts launch waits and drains active reviews before closing shared resources', async () => {
  const controller = new AbortController()
  const starts: number[] = []
  let closed = false
  let finish!: () => void
  const active = new Promise<void>(resolve => { finish = resolve })
  const batch = runBatch([1, 2, 3], {
    signal: controller.signal,
    prepare: async () => {}, start: async () => ({}),
    review: async item => { starts.push(item); await active; return item },
    close: async () => { closed = true },
  })
  const rejected = assert.rejects(batch, /cancelled/)
  await new Promise(resolve => setImmediate(resolve))
  controller.abort(new Error('cancelled'))
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(starts, [1])
  assert.equal(closed, false)
  finish()
  await rejected
  assert.equal(closed, true)
})


describe('review_batch', () => {
  it('validates the whole batch before launching and returns complete ordered results', async () => {
    const seen: string[] = []
    const tool = createReviewBatchTool(async request => {
      seen.push(request.key)
      await sleep(request.key === 'first' ? 5 : 0)
      return { key: request.key, ok: true, findings: [{ ...finding, evidence: 'x'.repeat(300001) }], error: null }
    })
    const signal = new AbortController().signal
    await assert.rejects(tool.call({ reviewers: [args('first'), { key: 'invalid' }] }, signal), /review_batch/)
    assert.deepEqual(seen, [])
    const result = await tool.call({ reviewers: [args('first'), args('second')] }, signal) as { key: string; findings: Finding[] }[]
    assert.deepEqual(seen, ['first', 'second'])
    assert.deepEqual(result.map(r => r.key), ['first', 'second'])
    assert.equal(result[0]!.findings[0]!.evidence.length, 300001)
  })
})
