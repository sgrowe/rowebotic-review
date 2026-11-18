import { stat, unlink } from 'node:fs/promises'
import { createServer, type ServerResponse } from 'node:http'
import { basename, resolve } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { Storage } from '@google-cloud/storage'
import pg from 'pg'
import { AuthError, TokenStore, type Credentials } from './auth.ts'
import { loadProject } from './config.ts'
import { GitHub, repoSlug } from './github.ts'
import { runHook } from './hooks.ts'
import { createReviewModel, reviewBatch } from './review.ts'
import { Watcher } from './watch.ts'

const retryMs = 60_000

type Status = {
  phase: string
  prs: { number: number; url: string }[]
  lastPollAt?: number
  nextPollAt?: number
}

function required(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required for serve`)
  return value
}

function bootstrapCredentials(raw: string): Credentials {
  let value: Partial<Credentials> | undefined
  try {
    value = JSON.parse(raw)
  } catch {
    throw new AuthError('ChatGPT bootstrap credentials must be JSON')
  }
  if (!value?.access || typeof value.access !== 'string' ||
      !value.refresh || typeof value.refresh !== 'string' ||
      !value.accountId || typeof value.accountId !== 'string' ||
      typeof value.expires !== 'number' || !Number.isSafeInteger(value.expires)) {
    throw new AuthError('ChatGPT bootstrap credentials are missing fields')
  }
  return { access: value.access, refresh: value.refresh, accountId: value.accountId, expires: value.expires }
}

async function loadTokenStore(client: pg.Client, bootstrap: string, signal: AbortSignal): Promise<TokenStore> {
  // A seed is replaced only by a more recently issued login. Running
  // revisions may still have an older Secret Manager version in their env.
  const seed = bootstrapCredentials(bootstrap)
  await client.query(`
    CREATE TABLE IF NOT EXISTS reviewer_oauth (
      singleton boolean PRIMARY KEY CHECK (singleton),
      seed_expires bigint NOT NULL,
      credentials jsonb NOT NULL
    )
  `)
  await client.query(`
    INSERT INTO reviewer_oauth VALUES (true, $1, $2)
    ON CONFLICT (singleton) DO UPDATE SET
      seed_expires = EXCLUDED.seed_expires, credentials = EXCLUDED.credentials
    WHERE EXCLUDED.seed_expires > reviewer_oauth.seed_expires
  `, [seed.expires, seed])
  const storage = {
    load: async () => {
      const result = await client.query<{ credentials: Credentials }>(
        'SELECT credentials FROM reviewer_oauth WHERE singleton',
      )
      return result.rows[0]?.credentials
    },
    save: async (credentials: Credentials) => {
      await client.query('UPDATE reviewer_oauth SET credentials = $1 WHERE singleton', [credentials])
    },
  }
  return new TokenStore((await storage.load())!, storage, signal)
}

type Report = (phase: string, error?: unknown) => void

async function runWithLock(
  connectionString: string,
  task: (client: pg.Client, signal: AbortSignal) => Promise<void>,
  report: Report,
  signal: AbortSignal,
): Promise<void> {
  while (!signal.aborted) {
    const client = new pg.Client({
      connectionString, connectionTimeoutMillis: 5000, query_timeout: 5000, keepAlive: true,
    })
    const lost = new AbortController()
    const stop = AbortSignal.any([signal, lost.signal])
    client.on('error', error => lost.abort(error))
    client.on('end', () => lost.abort(new Error('Coordination connection closed')))
    let heartbeat: NodeJS.Timeout | undefined
    let phase = 'waiting for database'
    try {
      report(phase)
      await client.connect()
      phase = 'waiting for previous revision'
      report(phase)
      while (!stop.aborted) {
        const result = await client.query<{ acquired: boolean }>(
          'SELECT pg_try_advisory_lock(1380931397, 1) AS acquired',
        )
        if (result.rows[0]?.acquired) break
        await sleep(5000, undefined, { signal: stop })
      }
      stop.throwIfAborted()
      heartbeat = setInterval(() => {
        void client.query('SELECT 1').catch(error => lost.abort(error))
      }, 5000)
      await task(client, stop)
      if (lost.signal.aborted) throw lost.signal.reason
    } catch (error) {
      if (signal.aborted) return
      phase = lost.signal.aborted ? 'database connection lost' : phase
      report(phase, error)
    } finally {
      clearInterval(heartbeat)
      await client.end().catch(() => {})
    }
    await sleep(retryMs, undefined, { signal }).catch(() => {})
  }
}

export async function serve(log: (line: string) => void, signal: AbortSignal): Promise<void> {
  const connectionString = required('DATABASE_URL')
  const bootstrap = required('ROWEBOTIC_CHATGPT_AUTH')
  const expectedLogin = required('ROWEBOTIC_GITHUB_LOGIN')
  const root = resolve(process.env.ROWEBOTIC_ROOT ?? process.cwd())
  const projectDir = process.env.ROWEBOTIC_CONFIG
  const setup = process.env.ROWEBOTIC_SETUP
  // These values are used only in this process.
  delete process.env.DATABASE_URL
  delete process.env.ROWEBOTIC_CHATGPT_AUTH

  const status: Status = { phase: 'starting', prs: [] }
  const rawLog = log
  const githubToken = process.env.GH_TOKEN
  log = line => rawLog(githubToken ? line.replaceAll(githubToken, '[redacted]') : line)
  const report: Report = (phase, error) => {
    status.phase = phase
    status.prs = []
    status.nextPollAt = undefined
    if (error) {
      status.nextPollAt = Date.now() + retryMs
      log(`${phase}: ${error instanceof Error ? error.message : String(error)}`)
    } else {
      log(phase)
    }
  }
  const archive = startArchive(required('BUCKET_NAME'), log)
  const server = createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store')
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end()
    } else if (req.url === '/health') {
      res.writeHead(200).end('ok')
    } else if (req.url === '/') {
      dashboard(res, status)
    } else {
      res.writeHead(404).end()
    }
  })
  await new Promise<void>((ok, fail) => {
    server.once('error', fail)
    server.listen(Number(process.env.PORT ?? 8080), '0.0.0.0', ok)
  })
  log('Dashboard listening')

  try {
    await runWithLock(connectionString, async (client, stop) => {
      let tokens: TokenStore | undefined
      while (!stop.aborted) {
        let failure = 'startup failed'
        try {
          report('preparing checkout')
          if (setup) {
            const code = await runHook(setup, [], process.cwd(), AbortSignal.any([stop, AbortSignal.timeout(15 * 60_000)]))
            if (code !== 0) throw new Error(`Setup exited with ${code ?? 'a signal'}`)
          }
          const project = await loadProject(root, projectDir ? resolve(projectDir) : undefined)
          if (!project.search) throw new Error('settings.json needs a watch search query')
          failure = 'GitHub authentication failed'
          const github = new GitHub({ cwd: root, signal: stop })
          const login = await github.login()
          if (login.toLowerCase() !== expectedLogin.toLowerCase()) {
            throw new AuthError(`GitHub logged in as ${login}; expected ${expectedLogin}`)
          }
          const repo = await github.repo()
          failure = 'ChatGPT authentication failed'
          tokens ??= await loadTokenStore(client, bootstrap, stop)
          await tokens.accessToken()
          const model = await createReviewModel(tokens)
          const watcher = new Watcher({
            github, repo, login, search: project.search, idleDelay: project.idleDelay, log, signal: stop,
            onStatus: ({ phase, at, nextPollAt }) => {
              if (phase !== 'retrying' || status.phase !== 'preparation failed') status.phase = phase
              if (phase === 'polling') status.lastPollAt = at
              status.nextPollAt = nextPollAt
              status.prs = []
            },
            reviewBatch: async (prs, batchSignal) => {
              status.prs = prs.map(pr => ({
                number: pr.number, url: `https://github.com/${repoSlug(repo)}/pull/${pr.number}`,
              }))
              return reviewBatch({
                root, project, prs, model, strictPrepare: true, print: log,
                signal: batchSignal, onTranscript: archive.track,
                onStage: phase => { status.phase = phase },
              })
            },
          })
          await watcher.run()
          return
        } catch (error) {
          if (stop.aborted) return
          report(failure, error)
          await sleep(retryMs, undefined, { signal: stop }).catch(() => {})
        }
      }
    }, report, signal)
  } finally {
    server.close()
    await archive.close()
  }
}

function startArchive(bucketName: string, log: (line: string) => void) {
  const bucket = new Storage({ retryOptions: { autoRetry: false }, timeout: 4000 }).bucket(bucketName)
  const files = new Map<string, { uploadedSize: number; finished: boolean }>()
  let flushing: Promise<void> | undefined

  function flush(): Promise<void> {
    flushing ??= Promise.all([...files].map(async ([path, file]) => {
      try {
        const { size } = await stat(path)
        if (size !== file.uploadedSize) {
          await bucket.upload(path, {
            destination: `transcripts/${basename(path)}`,
            resumable: false,
            metadata: { contentType: 'application/x-ndjson' },
          })
          file.uploadedSize = size
        }
        if (file.finished && size === (await stat(path)).size) {
          await unlink(path)
          files.delete(path)
        }
      } catch {
        log(`Could not archive transcript ${basename(path)}; will retry`)
      }
    })).then(() => {}).finally(() => { flushing = undefined })
    return flushing
  }

  const timer = setInterval(() => { void flush() }, 30_000)
  timer.unref()
  return {
    track(path: string, finished: boolean) {
      const file = files.get(path)
      if (file) file.finished = finished
      else files.set(path, { uploadedSize: 0, finished })
      if (finished) void flush()
    },
    async close() {
      clearInterval(timer)
      await Promise.race([
        (async () => { await flushing; await flush() })(),
        sleep(5000, undefined, { ref: false }),
      ])
    },
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]!)
}

function dashboard(res: ServerResponse, status: Status) {
  const date = (value?: number) => value === undefined ? '—' : new Date(value).toISOString()
  const links = status.prs.map(pr => `<li><a href="${escapeHtml(pr.url)}">PR #${pr.number}</a></li>`).join('')
  res.writeHead(200, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'",
  }).end(`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<meta http-equiv="refresh" content="15"><title>Rowebotic Review</title>
<style>
  :root { color-scheme: light dark }
  body { max-width: 40rem; margin: 3rem auto; padding: 0 1.25rem; font: 1rem / 1.55 system-ui, sans-serif }
  h1 { margin-bottom: 1.5rem; line-height: 1.15 }
  dl { display: grid; grid-template-columns: max-content 1fr; gap: .35rem 1rem }
  dd { margin: 0 }
</style>
</head><body><main><h1>Rowebotic Review</h1>
<dl><dt>Status</dt><dd>${escapeHtml(status.phase)}</dd>
<dt>Last poll</dt><dd>${date(status.lastPollAt)}</dd>
<dt>Next poll</dt><dd>${date(status.nextPollAt)}</dd></dl>
${links ? `<h2>Active reviews</h2><ul>${links}</ul>` : ''}
</main></body></html>`)
}
