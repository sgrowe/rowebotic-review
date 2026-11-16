// Watcher: review matching PRs in non-overlapping batches, using GitHub review history as
// the only durable state.

import { setTimeout as sleep } from 'node:timers/promises'
import { AuthError } from './auth.ts'
import { type GitHub, isReviewed, type Repo, type PullRequest } from './github.ts'
import { UsageLimitError } from './model.ts'

export const INTERVAL_MS = 3 * 60 * 1000
export const IDLE_MS = 90_000
export const DEBOUNCE_MS = 120_000
export const MAX_BATCH_SIZE = 10
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
  reviewBatch: (prs: PullRequest[], signal: AbortSignal) => Promise<PromiseSettledResult<{ headSha: string }>[]>
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

  /** Select and finish one batch before allowing another search. */
  async reviewBatch(): Promise<boolean> {
    const { github, repo, login, log, signal } = this.#deps
    const cutoff = this.#now() - RECENT_MS
    const numbers = await github.search(repo, searchQuery(this.#deps.search, this.#now()))
    const selected: PullRequest[] = []
    const retry = (number: number, error: unknown) => {
      log(`PR #${number}: ${error instanceof Error ? error.message : String(error)}. Retrying in 3 minutes.`)
      this.nextReviewAt.set(number, this.#now() + INTERVAL_MS)
    }
    for (const number of new Set(numbers)) {
      signal.throwIfAborted()
      if ((this.nextReviewAt.get(number) ?? 0) > this.#now()) continue
      try {
        const pr = await github.pullRequest(repo, number)
        const committedAt = await github.headCommittedAt(repo, pr.head.sha)
        if (committedAt < cutoff) {
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
        const previouslyReviewed = reviews.some(review => review.state !== 'PENDING' && Boolean(review.submitted_at))
        if (previouslyReviewed && committedAt > this.#now() - DEBOUNCE_MS) continue
        selected.push(pr)
        if (selected.length === MAX_BATCH_SIZE) break
      } catch (error) {
        if (signal.aborted || error instanceof UsageLimitError || error instanceof AuthError) throw error
        retry(number, error)
      }
    }
    if (!selected.length) return false
    for (const pr of selected) log(`PR #${pr.number}: reviewing ${pr.head.ref} at ${pr.head.sha.slice(0, 7)}.`)
    const results = await this.#deps.reviewBatch(selected, signal)
    signal.throwIfAborted()
    const fatal: (UsageLimitError | AuthError)[] = []
    for (const [index, pr] of selected.entries()) {
      try {
        const result = results[index]
        if (!result) throw new Error('missing batch result')
        if (result.status === 'rejected') throw result.reason
        if (result.value.headSha !== pr.head.sha) throw new Error('review returned a different head than selected')
        const current = await github.pullRequest(repo, pr.number)
        const submitted = await github.reviewsBy(repo, pr.number, login)
        if (!isReviewed(pr.head.sha, submitted)) {
          throw new Error('no submitted review found for the reviewed head; see the output above')
        }
        if (isReviewed(current.head.sha, submitted)) {
          log(`PR #${pr.number}: current head has been reviewed.`)
        } else {
          log(`PR #${pr.number}: new commits arrived; eligibility will be checked next batch.`)
        }
        this.nextReviewAt.delete(pr.number)
      } catch (error) {
        if (signal.aborted) throw error
        if (error instanceof UsageLimitError || error instanceof AuthError) fatal.push(error)
        else retry(pr.number, error)
      }
    }
    const auth = fatal.find(error => error instanceof AuthError)
    if (auth) throw auth
    const limits = fatal.filter((error): error is UsageLimitError => error instanceof UsageLimitError)
    if (limits.length) {
      // Convert unknown reset times to the existing one-hour fallback; run adds one minute.
      const reset = Math.max(...limits.map(error => error.resetsAt ?? this.#now() + UNKNOWN_RESET_WAIT_MS - 60_000))
      throw new UsageLimitError(limits[0]!.message, reset)
    }
    return true
  }

  async run(): Promise<void> {
    const { log, signal } = this.#deps
    log(`Watching ${this.#deps.repo.owner}/${this.#deps.repo.name} as ${this.#deps.login}: ${this.#deps.search}`)
    while (!signal.aborted) {
      try {
        if (await this.reviewBatch()) continue
        log('No PRs ready. Checking again in 90 seconds.')
      } catch (error) {
        if (signal.aborted) return
        if (error instanceof AuthError) throw error
        if (error instanceof UsageLimitError) {
          const wait = error.resetsAt ? Math.max(0, error.resetsAt - this.#now()) + 60_000 : UNKNOWN_RESET_WAIT_MS
          log(`Usage limit reached: ${error.message}. Sleeping until ${new Date(this.#now() + wait).toLocaleString()}.`)
          await this.#sleep(wait, signal).catch(() => {})
          continue
        }
        log(`Batch check failed: ${error instanceof Error ? error.message : String(error)}. Retrying in 90 seconds.`)
      }
      await this.#sleep(IDLE_MS, signal).catch(() => {})
    }
  }
}
