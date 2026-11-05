// Watcher: review matching PRs one at a time, using GitHub review history as
// the only durable state.

import { setTimeout as sleep } from 'node:timers/promises'
import { AuthError } from './auth.ts'
import { type GitHub, isReviewed, type Repo } from './github.ts'
import { UsageLimitError } from './model.ts'

export const INTERVAL_MS = 3 * 60 * 1000
export const RECENT_MS = 5 * 24 * 60 * 60 * 1000
const UNKNOWN_RESET_WAIT_MS = 60 * 60 * 1000

export function searchQuery(base: string, now: number): string {
  return `${base} updated:>=${new Date(now - RECENT_MS).toISOString()} sort:created-asc`
}

export type WatchDeps = {
  github: Pick<GitHub, 'search' | 'pullRequest' | 'headCommittedAt' | 'reviewsBy'>
  repo: Repo
  login: string
  search: string
  review: (prNumber: number, signal: AbortSignal) => Promise<unknown>
  log: (text: string) => void
  signal: AbortSignal
  now?: () => number
  sleep?: (ms: number, signal: AbortSignal) => Promise<unknown>
}

export class Watcher {
  readonly nextReviewAt = new Map<number, number>()
  readonly #staleHeads = new Map<number, string>()
  readonly #deps: WatchDeps
  readonly #now: () => number
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<unknown>

  constructor(deps: WatchDeps) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
    this.#sleep = deps.sleep ?? ((ms, signal) => sleep(ms, undefined, { signal }))
  }

  /** Reviews (or fails) at most one PR. Returns true if it handled one. */
  async reviewNext(): Promise<boolean> {
    const { github, repo, login, log, signal } = this.#deps
    const cutoff = this.#now() - RECENT_MS
    const numbers = await github.search(repo, searchQuery(this.#deps.search, this.#now()))
    for (const number of numbers) {
      if ((this.nextReviewAt.get(number) ?? 0) > this.#now()) continue
      try {
        const pr = await github.pullRequest(repo, number)
        // `updated` also moves on comments and labels, so check the head commit itself.
        if ((await github.headCommittedAt(repo, pr.head.sha)) < cutoff) {
          if (this.#staleHeads.get(number) !== pr.head.sha) {
            this.#staleHeads.set(number, pr.head.sha)
            log(`PR #${number}: head commit is older than 5 days; skipping.`)
          }
          continue
        }
        const reviews = await github.reviewsBy(repo, number, login)
        if (isReviewed(pr.head.sha, reviews)) continue
        if (reviews.some(review => review.state === 'PENDING')) {
          throw new Error('a pending review already exists; submit or discard it manually')
        }

        log(`PR #${number}: reviewing ${pr.head.ref} at ${pr.head.sha.slice(0, 7)}.`)
        await this.#deps.review(number, signal)

        const current = await github.pullRequest(repo, number)
        const submitted = await github.reviewsBy(repo, number, login)
        if (isReviewed(current.head.sha, submitted)) {
          log(`PR #${number}: current head has been reviewed.`)
        } else if (current.head.sha !== pr.head.sha && isReviewed(pr.head.sha, submitted)) {
          log(`PR #${number}: new commits arrived; cooling down for 3 minutes.`)
        } else {
          throw new Error('no submitted review found for the reviewed head; see the output above')
        }
        this.nextReviewAt.set(number, this.#now() + INTERVAL_MS)
        return true
      } catch (error) {
        if (signal.aborted || error instanceof UsageLimitError || error instanceof AuthError) throw error
        log(`PR #${number}: ${error instanceof Error ? error.message : String(error)}. Retrying in 3 minutes.`)
        this.nextReviewAt.set(number, this.#now() + INTERVAL_MS)
        // Refresh the list before choosing another PR.
        return true
      }
    }
    return false
  }

  async run(): Promise<void> {
    const { log, signal } = this.#deps
    log(`Watching ${this.#deps.repo.owner}/${this.#deps.repo.name} as ${this.#deps.login}: ${this.#deps.search}`)
    while (!signal.aborted) {
      try {
        if (await this.reviewNext()) continue
        log('No PRs ready. Checking again in 3 minutes.')
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof AuthError) throw error
        if (error instanceof UsageLimitError) {
          const wait = error.resetsAt ? Math.max(0, error.resetsAt - this.#now()) + 60_000 : UNKNOWN_RESET_WAIT_MS
          log(`Usage limit reached: ${error.message}. Sleeping until ${new Date(this.#now() + wait).toLocaleString()}.`)
          await this.#sleep(wait, signal).catch(() => {})
          continue
        }
        log(`GitHub check failed: ${error instanceof Error ? error.message : String(error)}. Retrying in 3 minutes.`)
      }
      await this.#sleep(INTERVAL_MS, signal).catch(() => {})
    }
  }
}
