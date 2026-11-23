import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { pendingReviewBlocker, pendingReviewFrom, type PendingReviewPage, STALE_PENDING_MS } from '../src/github.ts'

function page(nodes: PendingReviewPage['data']['repository']['pullRequest']['reviews']['nodes']): PendingReviewPage {
  return { data: { repository: { pullRequest: { reviews: { nodes } } } } }
}

describe('pending reviews', () => {
  it('reads the latest activity across the review and its comments', () => {
    const pending = pendingReviewFrom(page([{
      databaseId: 7,
      body: '',
      createdAt: '2026-11-23T11:40:00Z',
      updatedAt: '2026-11-23T11:41:00Z',
      comments: { totalCount: 2, nodes: [{ updatedAt: '2026-11-23T11:43:23Z' }, { updatedAt: '2026-11-23T11:42:00Z' }] },
    }]))
    assert.deepEqual(pending, { id: 7, body: '', lastActivityAt: Date.parse('2026-11-23T11:43:23Z'), commentCount: 2 })
    assert.equal(pendingReviewFrom(page([])), undefined)
  })

  it('blocks until the pending review has been idle for 15 minutes', () => {
    const at = Date.parse('2026-11-23T11:43:23Z')
    const pending = { id: 7, body: '', lastActivityAt: at, commentCount: 0 }
    assert.equal(pendingReviewBlocker(undefined, at), undefined)
    assert.match(pendingReviewBlocker(pending, at + 5 * 60_000)!, /updated 5 min ago; waiting until it has been idle for 15 min/)
    assert.equal(pendingReviewBlocker(pending, at + STALE_PENDING_MS), undefined)
  })
})
