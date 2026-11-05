// ChatGPT OAuth for the Codex backend: browser login (PKCE), token store, refresh.
// Endpoints and client id match the Codex CLI (and pi's openai-codex provider).

import { spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { createInterface } from 'node:readline'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_BASE = 'https://auth.openai.com'
const AUTHORIZE_URL = `${AUTH_BASE}/oauth/authorize`
const TOKEN_URL = `${AUTH_BASE}/oauth/token`
const CALLBACK_PORT = 1455
const CALLBACK_PATH = '/auth/callback'
const REDIRECT_URI = `http://localhost:${CALLBACK_PORT}${CALLBACK_PATH}`
const SCOPE = 'openid profile email offline_access'
const LOGIN_TIMEOUT_MS = 15 * 60 * 1000
const JWT_CLAIM = 'https://api.openai.com/auth'
const REFRESH_MARGIN_MS = 5 * 60 * 1000

export const homeDir = join(homedir(), '.rowebotic-review')
export const authPath = join(homeDir, 'auth.json')

export type Credentials = {
  access: string
  refresh: string
  /** Unix ms when the access token expires. */
  expires: number
  accountId: string
}

/** Login is needed: no token store, or the refresh token was rejected. */
export class AuthError extends Error {
  override name = 'AuthError'
}

export function accountIdFromToken(accessToken: string): string {
  const payload = accessToken.split('.')[1]
  if (payload) {
    try {
      const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
      const id = claims?.[JWT_CLAIM]?.chatgpt_account_id
      if (typeof id === 'string' && id) return id
    } catch {
      // fall through
    }
  }
  throw new AuthError('Access token has no ChatGPT account id')
}

async function readTokenResponse(response: Response, operation: string): Promise<Credentials> {
  const text = await response.text()
  if (!response.ok) {
    if (/invalid_grant|refresh_token_(expired|reused|invalidated)/.test(text)) {
      throw new AuthError(`Token ${operation} was rejected; run \`rowebotic-review login\`. ${text}`)
    }
    throw new Error(`Token ${operation} failed (${response.status}): ${text}`)
  }
  const json = JSON.parse(text)
  if (!json?.access_token || !json.refresh_token || typeof json.expires_in !== 'number') {
    throw new Error(`Token ${operation} response is missing fields`)
  }
  return {
    access: json.access_token,
    refresh: json.refresh_token,
    expires: Date.now() + json.expires_in * 1000,
    accountId: accountIdFromToken(json.access_token),
  }
}

export async function loadCredentials(path = authPath): Promise<Credentials> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    throw new AuthError(`No credentials at ${path}; run \`rowebotic-review login\``)
  }
  return JSON.parse(text) as Credentials
}

/** Atomic write: temp file then rename, mode 0600. */
export async function saveCredentials(creds: Credentials, path = authPath): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  const temp = `${path}.${process.pid}.tmp`
  await writeFile(temp, `${JSON.stringify(creds, null, 2)}\n`, { mode: 0o600 })
  await rename(temp, path)
}

export async function refreshCredentials(refreshToken: string): Promise<Credentials> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }),
    signal: AbortSignal.timeout(60_000),
  })
  return readTokenResponse(response, 'refresh')
}

/**
 * Holds the current credentials and refreshes them when they are close to
 * expiry. Refreshes are single-flight: concurrent callers share one promise,
 * because OpenAI rotates refresh tokens and a second refresh with the old
 * token would fail.
 */
export class TokenStore {
  #creds: Credentials
  #refreshing: Promise<Credentials> | undefined
  readonly path: string

  constructor(creds: Credentials, path = authPath) {
    this.#creds = creds
    this.path = path
  }

  static async load(path = authPath): Promise<TokenStore> {
    return new TokenStore(await loadCredentials(path), path)
  }

  get accountId(): string {
    return this.#creds.accountId
  }

  /** Access token, refreshed first if it expires within 5 minutes. */
  async accessToken(): Promise<string> {
    if (this.#creds.expires - Date.now() < REFRESH_MARGIN_MS) await this.refresh()
    return this.#creds.access
  }

  /** Refresh now (also used after a 401). */
  refresh(): Promise<Credentials> {
    this.#refreshing ??= (async () => {
      try {
        // Another process (a second run) may have refreshed already.
        const onDisk = await loadCredentials(this.path).catch(() => undefined)
        if (onDisk && onDisk.refresh !== this.#creds.refresh && onDisk.expires - Date.now() > REFRESH_MARGIN_MS) {
          this.#creds = onDisk
          return onDisk
        }
        const creds = await refreshCredentials(this.#creds.refresh)
        await saveCredentials(creds, this.path)
        this.#creds = creds
        return creds
      } finally {
        this.#refreshing = undefined
      }
    })()
    return this.#refreshing
  }
}


export function createPkce(): { verifier: string; challenge: string } {
  const verifier = randomBytes(32).toString('base64url')
  const challenge = createHash('sha256').update(verifier).digest('base64url')
  return { verifier, challenge }
}

export function authorizeUrl(challenge: string, state: string): string {
  const url = new URL(AUTHORIZE_URL)
  url.search = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    redirect_uri: REDIRECT_URI,
    scope: SCOPE,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    id_token_add_organizations: 'true',
    codex_cli_simplified_flow: 'true',
    originator: 'rowebotic-review',
  }).toString()
  return url.toString()
}

/** Pasted input: a redirect URL, `code#state`, `code=...&state=...`, or a bare code. */
export function parseAuthorizationInput(input: string): { code?: string; state?: string } {
  const value = input.trim()
  if (!value) return {}
  if (URL.canParse(value)) {
    const params = new URL(value).searchParams
    return { code: params.get('code') ?? undefined, state: params.get('state') ?? undefined }
  }
  if (value.includes('#')) {
    const [code, state] = value.split('#', 2)
    return { code: code || undefined, state: state || undefined }
  }
  if (value.includes('code=')) {
    const params = new URLSearchParams(value)
    return { code: params.get('code') ?? undefined, state: params.get('state') ?? undefined }
  }
  return { code: value }
}

export type CallbackServer = {
  port: number
  /** Resolves with the authorization code from the browser redirect. */
  wait(): Promise<string>
  close(): void
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`)
}

function page(title: string, detail = ''): string {
  return `<!doctype html><meta charset="utf-8"><title>rowebotic-review</title><body style="font-family:system-ui;margin:3rem"><h1>${escapeHtml(title)}</h1><p>${escapeHtml(detail)}</p>`
}

/** Loopback server for the OAuth redirect. Rejects if the port is taken. */
export async function startCallbackServer(options: {
  port: number
  state: string
  signal?: AbortSignal
}): Promise<CallbackServer> {
  const { state, signal } = options
  signal?.throwIfAborted()
  let settled = false
  let resolveWait!: (code: string) => void
  let rejectWait!: (error: unknown) => void
  const waitPromise = new Promise<string>((resolve, reject) => {
    resolveWait = resolve
    rejectWait = reject
  })
  // A closed or cancelled wait may never be observed.
  waitPromise.catch(() => undefined)
  const onAbort = () => finish({ error: signal?.reason })
  const finish = (result: { code: string } | { error: unknown }) => {
    if (settled) return
    settled = true
    signal?.removeEventListener('abort', onAbort)
    if ('code' in result) resolveWait(result.code)
    else rejectWait(result.error)
  }

  const server = createServer((request, response) => {
    const send = (status: number, html: string) => {
      response.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
      response.end(html)
    }
    const url = new URL(request.url ?? '/', 'http://localhost')
    if (request.method !== 'GET' || url.pathname !== CALLBACK_PATH) return send(404, page('Not found'))
    if (url.searchParams.get('state') !== state) return send(400, page('Sign-in failed', 'State mismatch.'))
    if (settled) return send(409, page('This sign-in has already been handled.'))
    const error = url.searchParams.get('error')
    if (error) {
      const description = url.searchParams.get('error_description') ?? error
      send(400, page('Sign-in failed', description))
      return finish({ error: new Error(`Authorization failed: ${description}`) })
    }
    const code = url.searchParams.get('code')
    if (!code) return send(400, page('Sign-in failed', 'Missing authorization code.'))
    send(200, page('Signed in to rowebotic-review', 'You can close this tab.'))
    finish({ code })
  })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(options.port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve()
    })
  })
  server.on('error', error => finish({ error }))
  signal?.addEventListener('abort', onAbort, { once: true })
  const address = server.address()
  return {
    port: typeof address === 'object' && address ? address.port : options.port,
    wait: () => waitPromise,
    close: () => {
      finish({ error: new Error('Callback server closed') })
      server.close()
      server.closeAllConnections()
    },
  }
}

/** Reads lines from stdin until one holds an authorization code. */
function readPastedCode(state: string, signal: AbortSignal, canWaitForever: boolean) {
  // terminal: false keeps Ctrl-C as a normal SIGINT for the CLI's handler.
  const rl = createInterface({ input: process.stdin, terminal: false })
  let onAbort = () => {}
  const code = new Promise<string>((resolve, reject) => {
    rl.on('line', line => {
      if (!line.trim()) return
      const parsed = parseAuthorizationInput(line)
      if (parsed.state && parsed.state !== state) return reject(new Error('State mismatch in the pasted input'))
      if (parsed.code) resolve(parsed.code)
    })
    // stdin closed (not a terminal): wait for the browser callback alone, if there is one.
    rl.on('close', () => {
      if (!canWaitForever) reject(new Error('stdin closed before an authorization code was pasted'))
    })
    onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
  })
  return {
    code,
    close: () => {
      signal.removeEventListener('abort', onAbort)
      rl.close()
    },
  }
}

function openBrowser(url: string) {
  try {
    const child = spawn('open', [url], { stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  } catch {
    // The URL is printed; the user can open it by hand.
  }
}

/** Browser login with PKCE. Waits for the loopback redirect or a pasted URL, stores the tokens. */
export async function login(log: (line: string) => void, signal?: AbortSignal): Promise<Credentials> {
  const { verifier, challenge } = createPkce()
  const state = randomBytes(16).toString('hex')
  const url = authorizeUrl(challenge, state)
  const timeout = AbortSignal.timeout(LOGIN_TIMEOUT_MS)
  const loginSignal = signal ? AbortSignal.any([signal, timeout]) : timeout

  // Port 1455 is shared with the Codex CLI; when it is taken, only the paste fallback works.
  const server = await startCallbackServer({ port: CALLBACK_PORT, state, signal: loginSignal }).catch(error => {
    log(`Could not listen on port ${CALLBACK_PORT} (${error instanceof Error ? error.message : error}).`)
    return undefined
  })
  const pasted = readPastedCode(state, loginSignal, server !== undefined)
  try {
    log(`Open this URL to sign in:\n\n${url}\n`)
    openBrowser(url)
    log(
      server
        ? 'Waiting for the browser. If it cannot reach localhost (e.g. over SSH), paste the URL it was sent to here and press Enter.'
        : 'After signing in, paste the URL the browser was sent to here and press Enter.',
    )
    const code = await Promise.race(server ? [server.wait(), pasted.code] : [pasted.code])
    const exchange = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        client_id: CLIENT_ID,
        code,
        code_verifier: verifier,
        redirect_uri: REDIRECT_URI,
      }),
      signal: loginSignal,
    })
    const creds = await readTokenResponse(exchange, 'exchange')
    await saveCredentials(creds)
    log(`Logged in. Credentials saved to ${authPath}`)
    return creds
  } catch (error) {
    if (timeout.aborted && !signal?.aborted) throw new Error('Login timed out after 15 minutes')
    throw error
  } finally {
    pasted.close()
    server?.close()
  }
}
