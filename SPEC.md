# rowebotic-review

A small TypeScript program that reviews GitHub pull requests with parallel AI reviewers and posts one GitHub review. It replaces the pi-based setup in the hpi checkout (pi, a patched pi-subagents clone, a fish launcher and a Node watcher) with one program we control.

Two things are first-class:

1. **Prompt cache use**, recorded as a key metric for every response.
2. **Retry on transient errors**, in one place that decides and records every retry.

Everything else stays minimal. There is no TUI: output is plain stdout lines plus one JSONL transcript per run.

## Commands

Run from the root of the repo under review.

| Command                         | What it does                                                                     |
| ------------------------------- | -------------------------------------------------------------------------------- |
| `rowebotic-review login`        | ChatGPT browser login. Stores tokens in `~/.rowebotic-review/auth.json`.         |
| `rowebotic-review review <pr>`  | Reviews one PR of the current repo and posts a `COMMENT` review.                 |
| `rowebotic-review watch`        | Reviews matching PRs one at a time, forever.                                     |

The repo comes from `gh repo view`. There is no dry run. The review event is always `COMMENT`: never `APPROVE`, never `REQUEST_CHANGES`. There is no footer.

Exit codes: 0 ok, 1 error or review not posted, 2 usage, 3 usage limit, 4 login needed, 130 stopped.

Install: `npm run install-locally` (runs `npm install && npm link`). Node 24 runs the `.ts` files directly (type stripping), so there is no build step.

## Flow of one review

1. Load `.rowebotic-review/` (see "Project files").
2. Fetch the PR with `gh`. Fork PRs are not supported: the head must be in the same repo.
3. `jj git fetch`, then run `.rowebotic-review/prepare` if it is executable. A failing `prepare` prints a warning and the run continues.
4. Revisions: `to` is the PR head commit SHA, `from` is `fork_point(remote_bookmarks(exact:"<baseRef>", exact:"origin") | <headSha>)`. That is the merge base GitHub diffs a PR from, so a stacked PR's diff leaves out its parent PR's changes. If the base branch is not on origin, `from` falls back to `fork_point(trunk() | <headSha>)` with a warning. The change ID comes from `jj log -r <sha> -T change_id --no-graph`.
5. Fetch the GitHub context with `gh` (see "GitHub context").
6. Start the MCP servers (one jj, one psql, one GitHub client, shared by all agents) and a Monty worker pool.
7. Run the orchestrator. It lists the changed files, picks concerns, starts reviewers with `asyncio.gather(review(...), ...)`, verifies their findings, posts the review, and replies with a JSON summary.
8. Print the summary, the per-agent cache table and the transcript path.

## Model and transport

- Model `gpt-6.1-sol`, `reasoning.effort: "high"`, both hardcoded.
- ChatGPT subscription through the Codex backend: `openai` SDK with `baseURL: https://chatgpt.com/backend-api/codex`.
- HTTP SSE through the raw `client.responses.create({ stream: true })`. Not `responses.stream()`: its strict event checks turn Codex quirks into errors. No WebSocket.
- Stateless: `store: false` and the full input on every request.
- The client is built with `organization: null, project: null`, so `OPENAI_ORG_ID` and `OPENAI_PROJECT_ID` in the environment can't add headers.
- Default headers: `chatgpt-account-id`, `originator: rowebotic-review`, `OpenAI-Beta: responses=experimental`. Per request: `session-id` (= the agent's cache key) and `x-codex-turn-state` (see "Prompt caching").

Request body. Everything except `input` is constant for an agent:

```
{ model, instructions, input,
  tools: [{ type: "function", name: "python", parameters: { code: string }, strict: true }],
  tool_choice: "auto", parallel_tool_calls: false,
  reasoning: { effort: "high", summary: "auto" },
  store: false, stream: true, include: ["reasoning.encrypted_content"],
  prompt_cache_key,
  text: { format: { type: "json_schema", name, strict: true, schema }, verbosity: "low" } }
```

### Login and tokens

- Browser OAuth (authorization code + PKCE) with the Codex CLI's client id `app_EMoamEEZ73f0CkXaXp7hrann`, as pi and the Codex CLI do. `login` prints the `auth.openai.com/oauth/authorize` URL, opens it with `open`, and waits for the redirect on a loopback server at `http://localhost:1455/auth/callback` (the `state` must match). If the port is taken (the Codex CLI uses it too) or the browser can't reach it (SSH), paste the redirect URL or code on stdin instead. 15-minute timeout. The code is exchanged at `auth.openai.com/oauth/token` with the same `redirect_uri`.
- `~/.rowebotic-review/auth.json` (mode 0600) holds `access`, `refresh`, `expires` and `accountId`. The account id is the JWT claim `["https://api.openai.com/auth"].chatgpt_account_id`.
- The SDK's `apiKey` is an async callback. It refreshes the token when less than 5 minutes are left.
- Refresh is single-flight: concurrent callers share one promise, because OpenAI rotates refresh tokens. Before refreshing it re-reads `auth.json`, in case another process refreshed first. The new tokens are written atomically (temp file + rename).
- `invalid_grant` or a revoked refresh token raises `AuthError`: "run `rowebotic-review login`". The SDK wraps errors from the `apiKey` callback in `OpenAIError`, so the classifier looks at `error.cause`.

## Prompt caching

Rules, per agent:

- `instructions`, tools, `text.format`, reasoning and `prompt_cache_key` never change.
- `instructions` hold no timestamps or run data. Run data goes in the first user message. So the orchestrator's instructions are the same across runs of one repo, and all reviewers share theirs.
- Input is append-only, and identical across retries.
- Output items are collected from `response.output_item.done` events by `output_index` and appended verbatim, including encrypted reasoning. Codex sends an **empty** `response.completed.output` (seen in the spike), so `completed.output` is used only as a fallback when nothing streamed, and to fill missing `encrypted_content`.
- `response.completed` or `response.done` ends a response.

Cache keys (≤ 64 characters, one constant each): `<owner/repo>:orchestrator` and `<owner/repo>:reviewer`. All reviewers share one key. The `session-id` header is set to the same value, so all reviewers share it too: Codex uses it for routing, and with a per-agent `session-id` a staggered reviewer's first request never hit its sibling's cache (0/6 in spike 5, against 5/6 with `session-id` = cache key).

**Staggered start**: the first `review()` call starts at once. The others wait until that reviewer's first model response completes or fails, so their first request can read its cached instructions prefix. A reviewer's 20-minute timer starts after the wait.

**Turn state**: Codex returns an `x-codex-turn-state` header on each response. Each agent sends back the latest one it received, as the Codex CLI does. In the spike this gave 1 cache miss in 28 follow-up turns, against 3 in 28 without it. Reviewers do not share each other's turn state: sending a sibling's turn state on a reviewer's first request made hits worse (5/8 against 7/8).

Spike findings (2026-11-05):

- The full body above is accepted, and replaying `reasoning` / `function_call` / `function_call_output` items under `store: false` works.
- `session-id` steers routing. Spike 5 used the real reviewer instructions (~4.3k tokens) with a fresh nonce per trial: agent A's first request, then agent B's. B hit A's cache in 0/6 trials with per-agent `session-id`s, and in 5/6 with `session-id` = cache key. An earlier, smaller spike had suggested no difference.
- `prompt_cache_retention: "24h"` is rejected with 400 "Unsupported parameter". The orchestrator's turn after a long `review()` gather can therefore miss the cache when the gap is longer than the cache TTL.
- Even with everything right, some requests miss the whole prefix (about 1 in 6 to 1 in 10 in the spikes and the smoke run). This looks like backend routing, which we can't control.
- Codex `message` items carry a `phase` (`final_answer` seen). No commentary messages appeared next to tool calls.
- The request id header is `x-oai-request-id`.

### Cache metrics

Every response records `input`, `cached`, `output`, `reasoning`, `hit = cached / input`, `durationMs`, `promptCacheKey`, `sessionId`, `turn`, `gapMs` (since the agent's previous response ended), request bytes and the request id.

A `cache_miss` record is written when `cached < previousInput − 1024`, where `previousInput` is the same agent's previous request's input tokens. Each turn line on stdout ends with `CACHE MISS` when that happens.

`run_end` and the stdout table have per-agent and per-role totals. The reviewer hit rate is split into turn 1 and turns ≥ 2: turn 1 measures the stagger and shared key; turns ≥ 2 measure append-only input.

Expected misses: the orchestrator's turn after a long `review()` gather (idle longer than the cache TTL) and nudge turns.

Open question: the two live smoke runs (two reviewers, one shared key) had full-prefix misses when both reviewers sent requests at about the same time, and the second reviewer's turn 1 missed both times. OpenAI documents that one prefix+key sent more than about 15 times a minute overflows to other machines, which would make a shared reviewer key worse with many parallel reviewers. The `response` and `cache_miss` records (with `gapMs`) are there to settle this on real runs.

Baseline from pi (2026-11-05, 25 reviews, 160 children): orchestrator 86%, children 75%. Children's turn 1 was always 0 cached, because all started at once.

## Retry

The SDK's own retries are off (`maxRetries: 0`). One outer loop around the whole streamed call decides and records every retry. That keeps usage-limit 429s from being retried, and avoids multiplied attempts.

Classification, in order:

1. Our abort (the run or agent signal fired) → rethrow, never retry. This is checked after the iterator ends too, because the SDK ends the stream silently on abort.
2. Idle timeout (no SSE event for 5 minutes, own timer and flag) → transient.
3. Usage limit: `code` or `type` in `usage_limit_reached | usage_not_included | rate_limit_exceeded` with `resets_at`, on an HTTP 429 body or a stream event → `UsageLimitError { resetsAt }`. `rate_limit_exceeded` without `resets_at` is transient.
4. Fatal: `context_length_exceeded`, `invalid_request_error`, `invalid_prompt`, other 4xx → fail.
5. 401 → force a token refresh and retry once.
6. Everything else is transient: `APIConnectionError`, any non-`APIError` from the iterator (undici `TypeError: terminated`), `APIError` with 408/409/429/5xx or no status (SSE `error` events surface as a thrown `APIError` with `status` undefined), `{ type: "error" }` and `response.failed` events, and EOF without `response.completed`.

`response.incomplete` fails without retry.

Backoff: 5 s, 15 s, 30 s, 60 s, 60 s, each ±20% jitter, then fail. `retry-after-ms` / `retry-after` replaces the backoff step, up to 5 minutes. Every retry writes a `retry` record and a stdout line.

Run-level abort: one run `AbortController`. Agent signals are `AbortSignal.any([run or orchestrator signal, timeout])`. A reviewer that hits `UsageLimitError` or `AuthError` aborts the run, and the error reaches `review` and the watcher (which sleeps until `resetsAt`). Other reviewer failures come back as `{ ok: false, error }`; `review()` never raises inside `gather`.

## Codemode

Each agent has exactly one tool, `python(code: string)`, run in Monty (`@pydantic/monty`).

- One Monty session per agent, so variables persist between calls like a REPL. One worker pool per run, `maxProcesses: 32`.
- Limits: `maxSuspensions: 100_000` per session, `maxFeedDurationSecs: 300`. Time spent in host calls does not count, so a long `review()` gather is fine.
- All functions are listed up front in `instructions` as typed Python stubs, sorted by name. ty type-checks each script against the same stubs before it runs. There are no search or describe functions, no store and no output files.
- The jj and psql servers' own `instructions` text is included once.
- Stubs come from MCP JSON schemas: `string→str`, `integer→int`, `number→float`, `boolean→bool`, `array→list[T]` (no `items` → `list[Any]`), `object→dict[str, Any]`, `enum→Literal[...]`, type arrays like `["string","null"]` → `str | None`, `$ref`/`anyOf`/unknown → `Any`. Optional params become `T | None = None`. All params are keyword-only (`*`, omitted when there are none). The tool description and param descriptions form the docstring. Python keywords get a trailing `_` (`from_`) and are mapped back.
- Host functions get kwargs as a trailing object, which may be a `Map` or null-prototype object. Values are deep-converted (`Map`→object, `Set`→array, `BigInt`→number or string), `None` optionals are dropped, and the MCP text content is joined. An MCP `isError` result raises `RuntimeError` with its text.
- Output to the model: captured stdout, then the last expression's value (strings as-is, else JSON). Middle-truncated at 300,000 characters with a "filter or slice" note.
- Syntax, type and runtime errors return the traceback (`err.display('traceback')`, or the ty diagnostics) as the tool output. `MontyCrashedError` loses the session: the next call gets a new one, and the output says the state was reset.
- GitHub write failures go back to the model. They are not retried automatically because they are not idempotent.

## Agents

| Agent        | Functions                                                                                                  | Output                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| Orchestrator | `jj_*`, `psql_*`, `review(...)`, GitHub `pull_request_read`, `pull_request_review_write`, `add_comment_to_pending_review` | `{ reviewPosted, newFindings, remainingIssues, failedReviewers, skippedConcerns }`     |
| Reviewer     | `jj_*`, `psql_*`, `read_doc(name)` (when the project has docs)                                              | `{ findings: [{ file, line, severity, summary, evidence, scenario \| null }] }`          |

`review(*, key, concern, scope, intent) -> ReviewResult { key, ok, findings, error }`. `concern` is a `str`; the docstring lists the project's concern names, and an unknown name returns `ok=False` with the valid names. It never raises. Duplicate keys get a `#2` suffix in logs.

The orchestrator posts the review itself: create a pending review on the head SHA, add one comment per finding, submit with `COMMENT`. If a pending review already exists it stops without deleting it.

A reviewer's first message is its concern body followed by the change ID, `from`, `to`, path scope and intent. Its instructions are the same for every reviewer.

### Structured final output

- A strict `text.format` json_schema is set from turn 1.
- The final answer is the last `message` item of a response with no function calls, parsed as JSON.
- Empty or unparseable → one follow-up user message ("Finish any checks you have not done, then reply with the final JSON."), then fail.

### Limits

Reviewer timeout 20 minutes (after the stagger wait), orchestrator 45 minutes, both through `AbortSignal`. Nothing else.

## GitHub context

Before the run, TS fetches with `gh` and puts it in the orchestrator's first message as JSON, marked untrusted:

- PR title, description, author, URL, head ref and SHA, base ref.
- Submitted reviews (pending ones are left out).
- Review threads through GraphQL, with `isResolved`, `isOutdated`, path, lines and all comments with URLs.
- Top-level conversation comments.

## Project files

In the reviewed repo, under `.rowebotic-review/`:

| Path                 | Role                                                                                                                   |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `settings.json`      | `{ "search": "<gh search qualifiers>" }`, used by `watch`                                                             |
| `concerns/<name>.md` | Frontmatter `description` and `when` (single-line values). Body = the reviewer's instructions. The list of concerns, with `description` and `when`, goes in the orchestrator's instructions. |
| `docs/<name>.md`     | Reference documents, read with `read_doc(name=...)`                                                                    |
| `instructions.md`    | Optional. Appended to both agents' instructions                                                                        |
| `prepare`            | Optional executable, run after `jj git fetch`. Failure warns and continues                                             |

`examples/hpi/.rowebotic-review/` holds the hpi setup: the seven concerns ported from `.pi/code-review/review-*`, the React effects doc, the hpi rules (AGENTS.md walk, ATHENA.md, local DB semantics) in `instructions.md`, and a `prepare` that runs `jj rebase -d 'trunk()' --simplify-parents && pnpm install --frozen-lockfile && make migrate`. The rebase is needed so `make migrate` runs trunk's migrations.

`PGDATABASE` is inherited from the environment (direnv in hpi). Start `watch` from a shell where it is set; `watch` warns when it is not.

## Watcher

Same logic as hpi's `pi-review-watch.ts`, in-process:

- Search: the settings string + ` updated:>=<now − 5 days, ISO> sort:created-asc`, with `--state open --limit 1000`, recomputed every scan.
- Skip a PR whose head commit is older than 5 days (logged once per head), before fetching its reviews.
- Skip it if my submitted review exists for the head SHA. Fail it if my pending review exists.
- One review at a time. After a run, check `gh` for a submitted review on the reviewed head; "new commits arrived" is fine if the old head was reviewed.
- 3-minute cooldown per PR after each review and after each error, while other PRs can continue. 3-minute wait when nothing is ready.
- Usage limit → sleep until `resetsAt` (+1 minute; 1 hour if unknown). `AuthError` stops the watcher.
- Ctrl-C aborts the active review and the watcher. A second Ctrl-C exits at once.
- Cooldowns live in memory only. Run one watcher per repo.

## Transcript

One file per run: `~/.rowebotic-review/sessions/<ISO ts>_<owner>-<repo>_pr<N>_<runId>.jsonl`. Every record has `ts`, `type` and `agentId`.

| Type          | Contents                                                                         |
| ------------- | -------------------------------------------------------------------------------- |
| `run_start`   | repo, PR, head SHA, run id                                                       |
| `agent_start` | role, instructions hash and length, cache key, session id, tool names            |
| `request`     | the new input items only (first message, tool outputs, nudges)                    |
| `response`    | output items, usage, hit rate, duration, gap, cache key, session id, request id   |
| `cache_miss`  | turn, previous input, input, cached, gap                                         |
| `code_exec`   | code, output, error, reset flag, nested calls with timings and errors            |
| `retry`       | attempt, delay, kind, error                                                      |
| `agent_end`   | final JSON or error, totals                                                      |
| `run_end`     | ok or error, duration, per-role totals, orchestrator result                      |

## stdout

One line per event, for example:

```
12:01:03 [bugs-server] turn 3 in 14.2k cached 13.9k (98%) out 1.1k 9.8s
12:01:05 [orchestrator] python: results = await asyncio.gather(*[ → 6 calls 512.3s
12:01:09 [design] retry 1 in 5s (transient): APIConnectionError: Connection error.
```

At the end: the posted flag, new findings ranked by severity, remaining issues, failed reviewers, skipped concerns, the per-agent cache table, and the transcript path.

## Code

| File                     | Role                                                                          |
| ------------------------ | ----------------------------------------------------------------------------- |
| `src/cli.ts`             | Arg parsing, wiring, SIGINT                                                   |
| `src/auth.ts`            | Browser login (PKCE), token store, refresh, account id                       |
| `src/model.ts`           | Client, streamed call, idle timeout, error classifier, retry loop, usage      |
| `src/agent.ts`           | Agent loop: input array, tool calls → codemode, final JSON, nudge             |
| `src/codemode.ts`        | Monty pool and session, stubs from MCP schemas, kwargs, output formatting     |
| `src/mcp.ts`             | jj and psql over stdio, GitHub over HTTP, tool lists, call → text            |
| `src/github.ts`          | `gh` helpers: repo, PR context (REST + GraphQL threads), reviews, search     |
| `src/review.ts`          | One review run: prep, context, orchestrator, `review()` with stagger, summary |
| `src/watch.ts`           | Watcher loop                                                                  |
| `src/transcript.ts`      | JSONL writer, cache metrics, stdout lines                                     |
| `src/config.ts`          | `.rowebotic-review/` loading                                                  |
| `src/prompts/*.md`       | Orchestrator, reviewer and codemode prompts                                   |
| `scripts/spike*.ts`      | Codex and Monty spikes; `dump-tools.ts` refreshes `test/fixtures/tools.json` |
| `scripts/smoke-reviewers.ts` | Live run of two staggered reviewers on one commit, with no GitHub writes. Run from the reviewed repo; `RR_PROJECT` points at a dir holding `.rowebotic-review/` |

Stack: Node 24, ESM, erasable TypeScript only. Deps: `openai`, `@pydantic/monty`, `@modelcontextprotocol/sdk`. Dev: `typescript` (`npm run check`), `oxlint` (`npm run lint`), `node --test` (`npm test`).
