// GitHub data through the `gh` CLI, and a small command runner.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function run(command: string, args: string[], options: { cwd?: string; signal?: AbortSignal } = {}): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, {
      cwd: options.cwd,
      signal: options.signal,
      timeout: 5 * 60_000,
      maxBuffer: 64 * 1024 * 1024,
    })
    return stdout
  } catch (error) {
    if (options.signal?.aborted) throw options.signal.reason ?? error
    const stderr = String((error as { stderr?: unknown }).stderr ?? '').trim()
    throw new Error(`${command} ${args.join(' ')} failed${stderr ? `: ${stderr}` : `: ${(error as Error).message}`}`)
  }
}

export type Repo = { owner: string; name: string }

export const repoSlug = (repo: Repo) => `${repo.owner}/${repo.name}`

export type PullRequest = {
  number: number
  title: string
  body: string | null
  html_url: string
  draft: boolean
  state: string
  user: { login: string } | null
  head: { ref: string; sha: string; repo: { full_name: string } | null }
  base: { ref: string }
}

export type Review = {
  id: number
  user: { login: string } | null
  state: string
  body: string
  submitted_at?: string | null
  commit_id: string
  html_url: string
}

export type IssueComment = { user: { login: string } | null; body: string; created_at: string; html_url: string }

export type ReviewThread = {
  id: string
  isResolved: boolean
  isOutdated: boolean
  path: string
  line: number | null
  originalLine: number | null
  comments: { author: string | null; body: string; createdAt: string; url: string }[]
}

export class GitHub {
  readonly cwd: string | undefined
  readonly signal: AbortSignal | undefined

  constructor(options: { cwd?: string; signal?: AbortSignal } = {}) {
    this.cwd = options.cwd
    this.signal = options.signal
  }

  async gh<T>(args: string[]): Promise<T> {
    return JSON.parse(await run('gh', args, { cwd: this.cwd, signal: this.signal })) as T
  }

  async api<T>(endpoint: string, paginate = false): Promise<T> {
    const args = ['api', '--hostname', 'github.com', endpoint]
    if (paginate) args.push('--paginate', '--slurp')
    const result = await this.gh<unknown>(args)
    return (paginate ? (result as unknown[][]).flat() : result) as T
  }

  async repo(): Promise<Repo> {
    const { nameWithOwner } = await this.gh<{ nameWithOwner: string }>(['repo', 'view', '--json', 'nameWithOwner'])
    const [owner, name] = nameWithOwner.split('/')
    return { owner: owner!, name: name! }
  }

  async login(): Promise<string> {
    return (await this.api<{ login: string }>('user')).login
  }

  pullRequest(repo: Repo, number: number): Promise<PullRequest> {
    return this.api<PullRequest>(`repos/${repoSlug(repo)}/pulls/${number}`)
  }

  reviews(repo: Repo, number: number): Promise<Review[]> {
    return this.api<Review[]>(`repos/${repoSlug(repo)}/pulls/${number}/reviews?per_page=100`, true)
  }

  async reviewsBy(repo: Repo, number: number, login: string): Promise<Review[]> {
    return (await this.reviews(repo, number)).filter(review => review.user?.login.toLowerCase() === login.toLowerCase())
  }

  issueComments(repo: Repo, number: number): Promise<IssueComment[]> {
    return this.api<IssueComment[]>(`repos/${repoSlug(repo)}/issues/${number}/comments?per_page=100`, true)
  }

  async reviewThreads(repo: Repo, number: number): Promise<ReviewThread[]> {
    const query = `query($owner: String!, $name: String!, $number: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 50, after: $cursor) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id isResolved isOutdated path line originalLine
          comments(first: 100) { nodes { author { login } body createdAt url } }
        }
      }
    }
  }
}`
    const threads: ReviewThread[] = []
    let cursor: string | undefined
    do {
      const args = ['api', 'graphql', '-f', `query=${query}`, '-f', `owner=${repo.owner}`, '-f', `name=${repo.name}`, '-F', `number=${number}`]
      if (cursor) args.push('-f', `cursor=${cursor}`)
      type Page = {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                pageInfo: { hasNextPage: boolean; endCursor: string | null }
                nodes: (Omit<ReviewThread, 'comments'> & { comments: { nodes: { author: { login: string } | null; body: string; createdAt: string; url: string }[] } })[]
              }
            }
          }
        }
      }
      const page = await this.gh<Page>(args)
      const connection = page.data.repository.pullRequest.reviewThreads
      for (const node of connection.nodes) {
        threads.push({ ...node, comments: node.comments.nodes.map(c => ({ ...c, author: c.author?.login ?? null })) })
      }
      cursor = connection.pageInfo.hasNextPage ? (connection.pageInfo.endCursor ?? undefined) : undefined
    } while (cursor)
    return threads
  }

  /** The account's own pending review on a PR. GitHub shows pending reviews only to their author. */
  async pendingReview(repo: Repo, number: number): Promise<PendingReview | undefined> {
    const query = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviews(states: PENDING, first: 1) {
        nodes { databaseId body createdAt updatedAt comments(first: 100) { totalCount nodes { updatedAt } } }
      }
    }
  }
}`
    return pendingReviewFrom(await this.gh<PendingReviewPage>([
      'api', 'graphql', '-f', `query=${query}`, '-f', `owner=${repo.owner}`, '-f', `name=${repo.name}`, '-F', `number=${number}`,
    ]))
  }

  /**
   * Clears an abandoned pending review so a new one can be created: submits it as-is, or deletes it
   * when it has neither comments nor a body. The submitted body has no Rowebotic heading, so it never
   * counts as a review of the head. A non-empty draft body is kept above the note.
   */
  async flushPendingReview(repo: Repo, number: number, pending: PendingReview): Promise<'submitted' | 'deleted'> {
    const endpoint = `repos/${repoSlug(repo)}/pulls/${number}/reviews/${pending.id}`
    if (!pending.commentCount && !pending.body.trim()) {
      await run('gh', ['api', '--hostname', 'github.com', '-X', 'DELETE', endpoint], { cwd: this.cwd, signal: this.signal })
      return 'deleted'
    }
    await run('gh', [
      'api', '--hostname', 'github.com', '-X', 'POST', `${endpoint}/events`, '-f', 'event=COMMENT', '-f', `body=${pending.body.trim() ? `${pending.body.trim()}\n\n${INTERRUPTED_REVIEW_BODY}` : INTERRUPTED_REVIEW_BODY}`,
    ], { cwd: this.cwd, signal: this.signal })
    return 'submitted'
  }

  async headCommittedAt(repo: Repo, sha: string): Promise<number> {
    const commit = await this.api<{ commit: { committer: { date: string } | null } }>(`repos/${repoSlug(repo)}/commits/${encodeURIComponent(sha)}`)
    return Date.parse(commit.commit.committer?.date ?? '')
  }

  /** Open PRs matching the search, as numbers, in the search's order. */
  async search(repo: Repo, search: string): Promise<number[]> {
    const prs = await this.gh<{ number: number }[]>(['pr', 'list', '--repo', repoSlug(repo), '--state', 'open', '--search', search, '--limit', '1000', '--json', 'number'])
    return prs.map(pr => pr.number)
  }
}

/** A pending review idle for this long is treated as abandoned, e.g. by a run killed mid-post. */
export const STALE_PENDING_MS = 15 * 60_000
export const INTERRUPTED_REVIEW_BODY = 'Comments from an interrupted review.'

export type PendingReview = { id: number; body: string; lastActivityAt: number; commentCount: number }

export type PendingReviewPage = {
  data: {
    repository: {
      pullRequest: {
        reviews: {
          nodes: { databaseId: number; body: string; createdAt: string; updatedAt: string; comments: { totalCount: number; nodes: { updatedAt: string }[] } }[]
        }
      }
    }
  }
}

export function pendingReviewFrom(page: PendingReviewPage): PendingReview | undefined {
  const node = page.data.repository.pullRequest.reviews.nodes[0]
  if (!node) return undefined
  const times = [node.createdAt, node.updatedAt, ...node.comments.nodes.map(comment => comment.updatedAt)].map(Date.parse)
  return { id: node.databaseId, body: node.body, lastActivityAt: Math.max(...times), commentCount: node.comments.totalCount }
}

/** Why a pending review still blocks a new review, or undefined once it is stale. */
export function pendingReviewBlocker(pending: PendingReview | undefined, now: number): string | undefined {
  if (!pending) return undefined
  const idle = now - pending.lastActivityAt
  if (idle >= STALE_PENDING_MS) return undefined
  return `a pending review was updated ${Math.floor(Math.max(0, idle) / 60_000)} min ago; waiting until it has been idle for ${STALE_PENDING_MS / 60_000} min`
}

export function isSubmittedRoweboticReview(review: Review): boolean {
  return review.state !== 'PENDING' && Boolean(review.submitted_at)
    && review.body?.trimStart().split('\n', 1)[0]?.trimEnd() === '**🤖 Rowebotic Review ✨**'
}

export function hasRoweboticReview(headSha: string, reviews: Review[]): boolean {
  return reviews.some(review => review.commit_id === headSha && isSubmittedRoweboticReview(review))
}

export type PrContext = {
  title: string
  author: string | null
  url: string
  headRef: string
  headSha: string
  baseRef: string
  description: string
  reviews: { author: string | null; state: string; submittedAt: string | null; commit: string; url: string; body: string }[]
  reviewThreads: ReviewThread[]
  comments: { author: string | null; createdAt: string; url: string; body: string }[]
}

export async function fetchContext(github: GitHub, repo: Repo, pr: PullRequest): Promise<PrContext> {
  const [reviews, reviewThreads, comments] = await Promise.all([
    github.reviews(repo, pr.number),
    github.reviewThreads(repo, pr.number),
    github.issueComments(repo, pr.number),
  ])
  return {
    title: pr.title,
    author: pr.user?.login ?? null,
    url: pr.html_url,
    headRef: pr.head.ref,
    headSha: pr.head.sha,
    baseRef: pr.base.ref,
    description: pr.body ?? '',
    reviews: reviews
      .filter(review => review.state !== 'PENDING')
      .map(review => ({
        author: review.user?.login ?? null,
        state: review.state,
        submittedAt: review.submitted_at ?? null,
        commit: review.commit_id,
        url: review.html_url,
        body: review.body,
      })),
    reviewThreads,
    comments: comments.map(comment => ({ author: comment.user?.login ?? null, createdAt: comment.created_at, url: comment.html_url, body: comment.body })),
  }
}
