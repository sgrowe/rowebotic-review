// ChatGPT OAuth for the Codex backend: device-code login, token store, refresh.
// Endpoints and client id match the Codex CLI (and pi's openai-codex provider).

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'

const CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const AUTH_BASE = 'https://auth.openai.com'
const TOKEN_URL = `${AUTH_BASE}/oauth/token`
const DEVICE_USER_CODE_URL = `${AUTH_BASE}/api/accounts/deviceauth/usercode`
const DEVICE_TOKEN_URL = `${AUTH_BASE}/api/accounts/deviceauth/token`
const DEVICE_VERIFICATION_URL = `${AUTH_BASE}/codex/device`
const DEVICE_REDIRECT_URI = `${AUTH_BASE}/deviceauth/callback`
const DEVICE_TIMEOUT_MS = 15 * 60 * 1000
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

/** Device-code login. Prints the URL and code, polls, stores the tokens. */
export async function login(log: (line: string) => void, signal?: AbortSignal): Promise<Credentials> {
  const start = await fetch(DEVICE_USER_CODE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: CLIENT_ID }),
    signal,
  })
  if (!start.ok) throw new Error(`Device code request failed (${start.status}): ${await start.text()}`)
  const device = (await start.json()) as { device_auth_id: string; user_code: string; interval: number | string }
  const intervalMs = Math.max(1, Number(device.interval) || 5) * 1000
  log(`Open ${DEVICE_VERIFICATION_URL} and enter code ${device.user_code}`)

  const deadline = Date.now() + DEVICE_TIMEOUT_MS
  let wait = intervalMs
  while (Date.now() < deadline) {
    await sleep(wait, undefined, { signal })
    const poll = await fetch(DEVICE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_auth_id: device.device_auth_id, user_code: device.user_code }),
      signal,
    })
    if (poll.ok) {
      const code = (await poll.json()) as { authorization_code: string; code_verifier: string }
      const exchange = await fetch(TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: CLIENT_ID,
          code: code.authorization_code,
          code_verifier: code.code_verifier,
          redirect_uri: DEVICE_REDIRECT_URI,
        }),
        signal,
      })
      const creds = await readTokenResponse(exchange, 'exchange')
      await saveCredentials(creds)
      log(`Logged in. Credentials saved to ${authPath}`)
      return creds
    }
    if (poll.status === 403 || poll.status === 404) continue
    const body = await poll.text()
    if (body.includes('deviceauth_authorization_pending')) continue
    if (body.includes('slow_down')) {
      wait += 5000
      continue
    }
    throw new Error(`Device login failed (${poll.status}): ${body}`)
  }
  throw new Error('Device login timed out')
}
