import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { PullRequest, Review } from '../src/github.ts'
import { UsageLimitError } from '../src/model.ts'
import { INTERVAL_MS, RECENT_MS, searchQuery, Watcher } from '../src/watch.ts'

const NOW = Date.parse('2026-11-05T12:00:00Z')

type FakePr = { sha: string; committedAt: number; reviews: Review[] }

function fake(prs: Record<number, FakePr>, order: number[]) {
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
    review: async number => {
      reviewed.push(number)
      await onReview(number)
    },
    log: text => logs.push(text),
    signal: new AbortController().signal,
    now: () => now,
    sleep: async () => {},
  })
  return {
    watcher,
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
  it('reviews the first unreviewed PR in search order, then skips it', async () => {
    const t = fake({ 1: { sha: 'a1', committedAt: recent, reviews: [] }, 2: { sha: 'b1', committedAt: recent, reviews: [] } }, [1, 2])
    assert.equal(await t.watcher.reviewNext(), true)
    assert.deepEqual(t.reviewed, [1])
    t.setNow(NOW + INTERVAL_MS + 1)
    assert.equal(await t.watcher.reviewNext(), true)
    assert.deepEqual(t.reviewed, [1, 2])
    assert.equal(await t.watcher.reviewNext(), false)
    assert.match(t.searches[0]!, /^label:x draft:false updated:>=/)
  })

  it('skips heads older than 5 days before fetching reviews, logging once per head', async () => {
    const t = fake({ 1: { sha: 'old', committedAt: NOW - RECENT_MS - 1, reviews: [] } }, [1])
    assert.equal(await t.watcher.reviewNext(), false)
    assert.equal(await t.watcher.reviewNext(), false)
    assert.deepEqual(t.reviewCalls, [])
    assert.equal(t.logs.filter(l => l.includes('older than 5 days')).length, 1)
  })

  it('fails on a pending review and cools that PR down while others continue', async () => {
    const pending: Review = { id: 2, user: { login: 'me' }, state: 'PENDING', body: '', submitted_at: null, commit_id: 'a1', html_url: '' }
    const t = fake({ 1: { sha: 'a1', committedAt: recent, reviews: [pending] }, 2: { sha: 'b1', committedAt: recent, reviews: [] } }, [1, 2])
    assert.equal(await t.watcher.reviewNext(), true)
    assert.deepEqual(t.reviewed, [])
    assert.match(t.logs.at(-1)!, /pending review/)
    assert.equal(await t.watcher.reviewNext(), true)
    assert.deepEqual(t.reviewed, [2])
  })

  it('cools down a failed review and one that posted nothing', async () => {
    const t = fake({ 1: { sha: 'a1', committedAt: recent, reviews: [] } }, [1])
    t.setOnReview(() => {
      throw new Error('model failed')
    })
    assert.equal(await t.watcher.reviewNext(), true)
    assert.equal(t.watcher.nextReviewAt.get(1), NOW + INTERVAL_MS)
    assert.equal(await t.watcher.reviewNext(), false)
    t.setOnReview(() => {})
    t.setNow(NOW + INTERVAL_MS + 1)
    assert.equal(await t.watcher.reviewNext(), true)
    assert.match(t.logs.at(-1)!, /no submitted review/)
  })

  it('accepts a review of the old head when new commits arrived during the run', async () => {
    const prs = { 1: { sha: 'a1', committedAt: recent, reviews: [] as Review[] } }
    const t = fake(prs, [1])
    t.setOnReview(number => {
      t.submit(number)
      prs[1].sha = 'a2'
    })
    assert.equal(await t.watcher.reviewNext(), true)
    assert.match(t.logs.at(-1)!, /new commits arrived/)
  })

  it('propagates usage limits so the loop can sleep until the reset', async () => {
    const t = fake({ 1: { sha: 'a1', committedAt: recent, reviews: [] } }, [1])
    t.setOnReview(() => {
      throw new UsageLimitError('limit', NOW + 1000)
    })
    await assert.rejects(t.watcher.reviewNext(), UsageLimitError)
    assert.equal(t.watcher.nextReviewAt.get(1), undefined)
  })
})
