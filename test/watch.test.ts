import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PullRequest, Review } from '../src/github.ts'
import { AuthError } from '../src/auth.ts'
import { UsageLimitError } from '../src/model.ts'
import { IDLE_MS, INTERVAL_MS, RECENT_MS, searchQuery, Watcher } from '../src/watch.ts'

const NOW = Date.parse('2026-11-05T12:00:00Z')

type FakePr = { sha: string; committedAt: number; reviews: Review[] }

function fake(prs: Record<number, FakePr>, order: number[]) {
  const controller = new AbortController()
  const sleeps: number[] = []
  const searches: string[] = []
  const reviewed: number[] = []
  const reviewCalls: string[] = []
  const logs: string[] = []
  let now = NOW
  const github = {
    search: async (_repo: unknown, query: string) => {
      searches.push(query)
      return order
    },
    pullRequest: async (_repo: unknown, number: number) => ({ number, head: { ref: `branch-${number}`, sha: prs[number]!.sha } }) as PullRequest,
    headCommittedAt: async (_repo: unknown, sha: string) => Object.values(prs).find(pr => pr.sha === sha)!.committedAt,
    reviewsBy: async (_repo: unknown, number: number) => {
      reviewCalls.push(`reviews ${number}`)
      return prs[number]!.reviews
    },
  }
  const submit = (number: number) => {
    prs[number]!.reviews.push({ id: 1, user: { login: 'me' }, state: 'COMMENTED', body: '', submitted_at: new Date(now).toISOString(), commit_id: prs[number]!.sha, html_url: '' })
  }
  let onReview: (number: number) => Promise<void> | void = submit
  const watcher = new Watcher({
    github,
    repo: { owner: 'o', name: 'r' },
    login: 'me',
    search: 'label:x draft:false',
    reviewBatch: async selected => Promise.allSettled(selected.map(async pr => {
      reviewed.push(pr.number)
      await onReview(pr.number)
      return { headSha: pr.head.sha }
    })),
    log: text => logs.push(text),
    signal: controller.signal,
    now: () => now,
    sleep: async ms => { sleeps.push(ms); controller.abort() },
  })
  return {
    watcher,
    sleeps,
    controller,
    searches,
    reviewed,
    reviewCalls,
    logs,
    setNow: (t: number) => (now = t),
    setOnReview: (fn: (number: number) => Promise<void> | void) => (onReview = fn),
    submit,
  }
}

const recent = NOW - 60_000

describe('searchQuery', () => {
  it('adds the updated cutoff and oldest-created order', () => {
    assert.equal(searchQuery('label:x', NOW), 'label:x updated:>=2026-10-31T12:00:00.000Z sort:created-asc')
  })
})

describe('Watcher', () => {
  it('reviews eligible PRs together in search order, then skips reviewed heads', async () => {
    const t = fake({ 1: { sha: 'a1', committedAt: recent, reviews: [] }, 2: { sha: 'b1', committedAt: recent, reviews: [] } }, [1, 2])
    assert.equal(await t.watcher.reviewBatch(), true)
        assert.deepEqual(t.reviewed, [1, 2])
    assert.equal(await t.watcher.reviewBatch(), false)
    assert.match(t.searches[0]!, /^label:x draft:false updated:>=/)
  })

  it('skips heads older than 5 days before fetching reviews, logging once per head', async () => {
    const t = fake({ 1: { sha: 'old', committedAt: NOW - RECENT_MS - 1, reviews: [] } }, [1])
    assert.equal(await t.watcher.reviewBatch(), false)
    assert.equal(await t.watcher.reviewBatch(), false)
    assert.deepEqual(t.reviewCalls, [])
    assert.equal(t.logs.filter(l => l.includes('older than 5 days')).length, 1)
  })

  it('fails on a pending review and cools that PR down while others continue', async () => {
    const pending: Review = { id: 2, user: { login: 'me' }, state: 'PENDING', body: '', submitted_at: null, commit_id: 'a1', html_url: '' }
    const t = fake({ 1: { sha: 'a1', committedAt: recent, reviews: [pending] }, 2: { sha: 'b1', committedAt: recent, reviews: [] } }, [1, 2])
    assert.equal(await t.watcher.reviewBatch(), true)
    assert.ok(t.logs.some(line => line.includes('pending review')))
    assert.deepEqual(t.reviewed, [2])
  })

  it('cools down a failed review and one that posted nothing', async () => {
    const t = fake({ 1: { sha: 'a1', committedAt: recent, reviews: [] } }, [1])
    t.setOnReview(() => {
      throw new Error('model failed')
    })
    assert.equal(await t.watcher.reviewBatch(), true)
    assert.equal(t.watcher.nextReviewAt.get(1), NOW + INTERVAL_MS)
    assert.equal(await t.watcher.reviewBatch(), false)
    t.setOnReview(() => {})
    t.setNow(NOW + INTERVAL_MS + 1)
    assert.equal(await t.watcher.reviewBatch(), true)
    assert.match(t.logs.at(-1)!, /no submitted review/)
  })

  it('accepts a review of the old head when new commits arrived during the run', async () => {
    const prs = { 1: { sha: 'a1', committedAt: recent, reviews: [] as Review[] } }
    const t = fake(prs, [1])
    t.setOnReview(number => {
      t.submit(number)
      prs[1].sha = 'a2'
    })
    assert.equal(await t.watcher.reviewBatch(), true)
    assert.match(t.logs.at(-1)!, /new commits arrived/)
  })

  it('propagates usage limits so the loop can sleep until the reset', async () => {
    const t = fake({ 1: { sha: 'a1', committedAt: recent, reviews: [] } }, [1])
    t.setOnReview(() => {
      throw new UsageLimitError('limit', NOW + 1000)
    })
    await assert.rejects(t.watcher.reviewBatch(), UsageLimitError)
    assert.equal(t.watcher.nextReviewAt.get(1), undefined)
  })
})

it('takes at most ten eligible PRs, then picks up the remainder', async () => {
  const prs = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [i + 1, { sha: `sha${i}`, committedAt: recent, reviews: [] }]))
  const t = fake(prs, Object.keys(prs).map(Number))
  await t.watcher.reviewBatch()
  assert.deepEqual(t.reviewed, [1,2,3,4,5,6,7,8,9,10])
  await t.watcher.reviewBatch()
  assert.deepEqual(t.reviewed, [1,2,3,4,5,6,7,8,9,10,11,12])
})

it('debounces only previously reviewed PRs and includes the two-minute boundary', async () => {
  const prs = { 1: { sha: 'a', committedAt: recent, reviews: [] as Review[] }, 2: { sha: 'b', committedAt: recent, reviews: [] as Review[] } }
  const t = fake(prs, [1,2])
  t.submit(1)
  prs[1].sha = 'new'
  await t.watcher.reviewBatch()
  assert.deepEqual(t.reviewed, [2])
  t.setNow(NOW + 60_000)
  await t.watcher.reviewBatch()
  assert.deepEqual(t.reviewed, [2,1])
  assert.equal(t.watcher.nextReviewAt.size, 0)
})

it('waits for peers before surfacing a usage limit', async () => {
  const t = fake({ 1: { sha: 'a', committedAt: recent, reviews: [] }, 2: { sha: 'b', committedAt: recent, reviews: [] } }, [1,2])
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  t.setOnReview(async number => {
    if (number === 1) throw new UsageLimitError('limit', NOW + 1000)
    started()
    await gate
    t.submit(number)
  })
  let settled = false
  const pending = t.watcher.reviewBatch().finally(() => { settled = true })
  await ready
  assert.equal(settled, false)
  assert.deepEqual(t.reviewed, [1,2])
  release()
  await assert.rejects(pending, UsageLimitError)
  assert.ok(t.logs.some(line => line.includes('PR #2: current head has been reviewed')))
})

it('sleeps 90 seconds after an empty scan', async () => {
  const t = fake({}, [])
  await t.watcher.run()
  assert.deepEqual(t.sleeps, [IDLE_MS])
})

it('does not search again until the whole batch has settled', async () => {
  const t = fake({ 1: { sha: 'a', committedAt: recent, reviews: [] }, 2: { sha: 'b', committedAt: recent, reviews: [] } }, [1,2])
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  let started!: () => void
  const ready = new Promise<void>(resolve => { started = resolve })
  t.setOnReview(async number => {
    if (number === 2) { started(); await gate }
    t.submit(number)
  })
  const running = t.watcher.run()
  await ready
  assert.equal(t.searches.length, 1)
  release()
  await running
  assert.equal(t.searches.length, 2)
  assert.deepEqual(t.sleeps, [IDLE_MS])
})

it('gives authentication errors precedence over limits after processing peers', async () => {
  const t = fake({ 1: { sha: 'a', committedAt: recent, reviews: [] }, 2: { sha: 'b', committedAt: recent, reviews: [] } }, [1,2])
  t.setOnReview(number => { throw number === 1 ? new UsageLimitError('limit', NOW + 1000) : new AuthError('expired') })
  await assert.rejects(t.watcher.reviewBatch(), AuthError)
  assert.deepEqual(t.reviewed, [1,2])
})

it('waits until the latest reset across batch usage errors', async () => {
  const t = fake({ 1: { sha: 'a', committedAt: recent, reviews: [] }, 2: { sha: 'b', committedAt: recent, reviews: [] } }, [1,2])
  t.setOnReview(number => { throw new UsageLimitError('limit', NOW + number * 1000) })
  await t.watcher.run()
  assert.deepEqual(t.sleeps, [62_000])
})
