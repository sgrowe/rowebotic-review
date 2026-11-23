import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import type { Monty } from '@pydantic/monty'
import type { Concern } from '../src/config.ts'
import type { McpServer, McpServers } from '../src/mcp.ts'
import { FatalModelError, UsageLimitError } from '../src/model.ts'
import { batchPoolCapacity, PR_START_INTERVAL_MS, type ChildRun, createReviewFunctions, createReviewRunner, type Finding, type ReviewResult, type ReviewUpdate, runBatch, startReviewResources, TYPE_DEFS, transcriptFile } from '../src/review.ts'
import { CodeMode, createPool, type HostFunction } from '../src/codemode.ts'

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

  it('runs security reviewers in their own cache group and isolates an access failure', async () => {
    const events: string[] = []
    let stop: unknown
    const run = createReviewRunner({
      concerns: [...concerns, { name: 'security', description: 's', when: 'always', body: '', security: true }],
      timeoutMs: 1000,
      log: () => {},
      stopRun: error => { stop = error },
      runChild: async child => {
        events.push(child.id)
        if (child.concern.security) {
          await sleep(10)
          throw new FatalModelError('Daybreak Blue access is unavailable')
        }
        return [finding]
      },
    })
    const signal = new AbortController().signal
    const [security, ordinary] = await Promise.all([run(args('security', 'security'), signal), run(args('bugs'), signal)])
    assert.deepEqual(events, ['security', 'bugs'])
    assert.equal(security.ok, false)
    assert.match(security.error!, /Daybreak Blue access is unavailable/)
    assert.equal(ordinary.ok, true)
    assert.equal(stop, undefined)
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

it('starts immediately then spaces overlapping PRs one second apart in selection order', async () => {
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
  assert.deepEqual(times, [0, 1000, 2000])
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

it('stops launching on a soft stop but lets launched reviews finish', async () => {
  const stopping = new AbortController()
  const starts: number[] = []
  let closed = false
  let finish!: () => void
  const active = new Promise<void>(resolve => { finish = resolve })
  const batch = runBatch([1, 2, 3], {
    signal: new AbortController().signal,
    stopping: stopping.signal,
    prepare: async () => {}, start: async () => ({}),
    review: async item => { starts.push(item); await active; return item },
    close: async () => { closed = true },
  })
  await new Promise(resolve => setImmediate(resolve))
  stopping.abort()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(starts, [1])
  assert.equal(closed, false)
  finish()
  const results = await batch
  assert.deepEqual(results.map(r => r.status), ['fulfilled', 'rejected', 'rejected'])
  assert.match(String((results[1] as PromiseRejectedResult).reason), /shutting down/)
  assert.equal(closed, true)
})

it('skips preparation entirely when stopping before the batch starts', async () => {
  const stopping = new AbortController()
  stopping.abort()
  const calls: string[] = []
  const results = await runBatch([1, 2], {
    stopping: stopping.signal,
    prepare: async () => { calls.push('prepare') }, start: async () => { calls.push('start') },
    review: async item => item, close: async () => { calls.push('close') },
  })
  assert.deepEqual(calls, [])
  assert.deepEqual(results.map(r => r.status), ['rejected', 'rejected'])
})


describe('createReviewFunctions', () => {
  // Each reviewer finishes when the test calls `finish(key)`.
  function reviews() {
    const finishers = new Map<string, (result?: Partial<ReviewResult>) => void>()
    const aborted: string[] = []
    const logs: string[] = []
    const r = createReviewFunctions({
      concerns,
      log: text => logs.push(text),
      run: (request, signal) => new Promise<ReviewResult>(resolve => {
        finishers.set(request.key, result => resolve({ key: request.key, ok: true, findings: [finding], error: null, ...result }))
        signal.addEventListener('abort', () => {
          aborted.push(request.key)
          resolve({ key: request.key, ok: false, findings: [], error: 'aborted' })
        })
      }),
    })
    const fn = (name: string) => r.functions.find(f => f.name === name)!
    const signal = new AbortController().signal
    const start = (key: string, concern = 'bugs') => fn('start_review').call({ key, concern, scope: 'all', intent: 'i' }, signal) as Promise<string>
    const wait = (s = signal) => fn('wait_reviews').call({}, s) as Promise<ReviewUpdate>
    const finish = async (key: string, result?: Partial<ReviewResult>) => {
      finishers.get(key)!(result)
      await new Promise(resolve => setImmediate(resolve))
    }
    return { r, start, wait, finish, aborted, logs, signal }
  }

  it('starts reviewers without waiting, makes keys unique and rejects unknown concerns', async () => {
    const t = reviews()
    assert.equal(await t.start('bugs'), 'bugs')
    assert.equal(await t.start('bugs'), 'bugs#2')
    assert.equal(await t.start('orchestrator', 'design'), 'orchestrator#2')
    await assert.rejects(t.start('x', 'nope'), /unknown concern nope; use one of: bugs, design/)
    await t.r.close()
  })

  it('returns each result once, as reviewers finish, and waits when none are ready', async () => {
    const t = reviews()
    await t.start('slow')
    await t.start('fast')
    let waited: ReviewUpdate | undefined
    const pending = t.wait().then(update => { waited = update })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(waited, undefined)
    await t.finish('fast')
    await pending
    assert.deepEqual(waited, { finished: [{ key: 'fast', ok: true, findings: [finding], error: null }], running: ['slow'] })
    await t.finish('slow', { ok: false, findings: [], error: 'timed out' })
    assert.deepEqual(await t.wait(), { finished: [{ key: 'slow', ok: false, findings: [], error: 'timed out' }], running: [] })
    assert.deepEqual(await t.wait(), { finished: [], running: [] })
  })

  it('refuses new reviewers on a soft stop and ends the run unposted', async () => {
    const stopping = new AbortController()
    const stopped: Error[] = []
    let finishA!: () => void
    const r = createReviewFunctions({
      concerns, log: () => {}, stopping: stopping.signal, stopRun: error => stopped.push(error),
      run: request => new Promise<ReviewResult>(resolve => { finishA = () => resolve({ key: request.key, ok: true, findings: [], error: null }) }),
    })
    const call = (name: string, args = {}) => r.functions.find(f => f.name === name)!.call(args, new AbortController().signal)
    await call('start_review', { key: 'a', concern: 'bugs', scope: 'all', intent: 'i' })
    stopping.abort()
    await assert.rejects(call('start_review', { key: 'b', concern: 'bugs', scope: 'all', intent: 'i' }), /shutting down/)
    assert.match(String(stopped[0]), /shutting down/)
    finishA()
    assert.deepEqual(await call('wait_reviews'), { finished: [{ key: 'a', ok: true, findings: [], error: null }], running: [] })
  })

  it('turns a rejected reviewer into a failed result and keeps delivered results for review_results', async () => {
    const r = createReviewFunctions({ concerns, log: () => {}, run: async () => { throw new Error('boom') } })
    const call = (name: string, args = {}) => r.functions.find(f => f.name === name)!.call(args, new AbortController().signal)
    await call('start_review', { key: 'a', concern: 'bugs', scope: 'all', intent: 'i' })
    const failed = { key: 'a', ok: false, findings: [], error: 'Error: boom' }
    assert.deepEqual(await call('wait_reviews'), { finished: [failed], running: [] })
    assert.deepEqual(await call('review_results'), [failed])
  })

  it('serves concurrent waits without delivering a result twice, and aborts a wait', async () => {
    const t = reviews()
    await t.start('a')
    const [first, second] = [t.wait(), t.wait()]
    await t.finish('a')
    const updates = await Promise.all([first, second])
    assert.deepEqual(updates.flatMap(u => u.finished.map(r => r.key)), ['a'])
    await t.start('b')
    const controller = new AbortController()
    const aborted = t.wait(controller.signal)
    controller.abort(new Error('stop'))
    await assert.rejects(aborted, /stop/)
    await t.r.close()
  })

  it('refuses guarded writes until every result has been read', async () => {
    const t = reviews()
    const writes: unknown[] = []
    const write = t.r.guard({ name: 'pull_request_review_write', stub: '', call: async args => { writes.push(args); return 'ok' } } as HostFunction)
    await t.start('a')
    await assert.rejects(write.call({ method: 'create' }, t.signal), /not collected yet: a\. Call wait_reviews\(\)/)
    await t.finish('a')
    await assert.rejects(write.call({ method: 'create' }, t.signal), /not collected yet: a/)
    await t.wait()
    assert.equal(await write.call({ method: 'create' }, t.signal), 'ok')
    assert.equal(writes.length, 1)
  })

  it('wakes an early final answer once per newly finished reviewer', async () => {
    const t = reviews()
    assert.equal(await t.r.beforeFinish(t.signal), undefined)
    await t.start('a')
    await t.start('b')
    let wake: string | undefined
    const pending = t.r.beforeFinish(t.signal).then(text => { wake = text })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(wake, undefined)
    await t.finish('a')
    await pending
    assert.match(wake!, /Finished since your last wait_reviews\(\) call: a\.\nStill running: b\./)
    // Replying again without reading `a` waits for the next reviewer.
    const second = t.r.beforeFinish(t.signal)
    await t.finish('b')
    assert.match((await second)!, /Finished since your last wait_reviews\(\) call: a, b\.\nStill running: none\./)
    // Nothing new: accept, with a warning about the unread results.
    assert.equal(await t.r.beforeFinish(t.signal), undefined)
    assert.match(t.logs.join('\n'), /unread reviewer results: a, b/)
  })

  it('aborts reviewers still running on close and waits for them', async () => {
    const t = reviews()
    await t.start('a')
    await t.r.close()
    assert.deepEqual(t.aborted, ['a'])
    assert.match(t.logs.join('\n'), /stopping reviewers still running: a/)
    await assert.rejects(t.start('b'), /can no longer be started/)
  })

  it('keeps reviewers running between Python scripts', async () => {
    const t = reviews()
    const pool = await createPool(1)
    const codemode = new CodeMode({ pool, functions: t.r.functions, typeDefs: TYPE_DEFS, signal: t.signal })
    try {
      const started = await codemode.run('key = await start_review(key="bugs", concern="bugs", scope="all", intent="i")\nkey')
      assert.equal(started.error, undefined, started.output)
      assert.equal(started.output, 'bugs')
      await t.finish('bugs')
      const collected = await codemode.run('update = await wait_reviews()\nnew_findings: list[NewFinding] = [{**f, "concerns": ["bugs"]} for r in update["finished"] for f in r["findings"]]\n[len(update["running"]), new_findings[0]["file"]]')
      assert.equal(collected.error, undefined, collected.output)
      assert.equal(collected.output, '[\n 0,\n "a.ts"\n]')
    } finally {
      await codemode.close()
      await pool.close()
    }
  })
})
