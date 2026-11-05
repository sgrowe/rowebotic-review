import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { describe, it } from 'node:test'
import { authorizeUrl, createPkce, parseAuthorizationInput, startCallbackServer } from '../src/auth.ts'

describe('createPkce', () => {
  it('makes a base64url sha256 challenge of the verifier', () => {
    const { verifier, challenge } = createPkce()
    assert.match(verifier, /^[A-Za-z0-9_-]{43}$/)
    assert.equal(challenge, createHash('sha256').update(verifier).digest('base64url'))
  })
})

describe('authorizeUrl', () => {
  it('sets the Codex authorize params', () => {
    const url = new URL(authorizeUrl('CHALLENGE', 'STATE'))
    assert.equal(url.origin + url.pathname, 'https://auth.openai.com/oauth/authorize')
    assert.deepEqual(Object.fromEntries(url.searchParams), {
      response_type: 'code',
      client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
      redirect_uri: 'http://localhost:1455/auth/callback',
      scope: 'openid profile email offline_access',
      code_challenge: 'CHALLENGE',
      code_challenge_method: 'S256',
      state: 'STATE',
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      originator: 'rowebotic-review',
    })
  })
})

describe('parseAuthorizationInput', () => {
  it('reads code and state from a redirect URL', () => {
    assert.deepEqual(parseAuthorizationInput(' http://localhost:1455/auth/callback?code=abc&state=xyz \n'), {
      code: 'abc',
      state: 'xyz',
    })
  })
  it('reads code#state', () => {
    assert.deepEqual(parseAuthorizationInput('abc#xyz'), { code: 'abc', state: 'xyz' })
  })
  it('reads a query string', () => {
    assert.deepEqual(parseAuthorizationInput('code=abc&state=xyz'), { code: 'abc', state: 'xyz' })
  })
  it('takes anything else as a raw code', () => {
    assert.deepEqual(parseAuthorizationInput('abc'), { code: 'abc' })
    assert.deepEqual(parseAuthorizationInput('  '), {})
  })
})

describe('startCallbackServer', () => {
  const callback = (port: number, query: string) => fetch(`http://127.0.0.1:${port}/auth/callback?${query}`)

  it('resolves with the code when the state matches', async () => {
    const server = await startCallbackServer({ port: 0, state: 's1' })
    try {
      const response = await callback(server.port, 'code=abc&state=s1')
      assert.equal(response.status, 200)
      assert.match(await response.text(), /close this tab/)
      assert.equal(await server.wait(), 'abc')
    } finally {
      server.close()
    }
  })

  it('answers 400 to a wrong state and keeps waiting', async () => {
    const server = await startCallbackServer({ port: 0, state: 's1' })
    try {
      const bad = await callback(server.port, 'code=evil&state=other')
      assert.equal(bad.status, 400)
      await bad.text()
      const good = await callback(server.port, 'code=abc&state=s1')
      assert.equal(good.status, 200)
      await good.text()
      assert.equal(await server.wait(), 'abc')
    } finally {
      server.close()
    }
  })

  it('rejects on an authorization error', async () => {
    const server = await startCallbackServer({ port: 0, state: 's1' })
    try {
      const response = await callback(server.port, 'error=access_denied&error_description=User+said+no&state=s1')
      assert.equal(response.status, 400)
      assert.match(await response.text(), /User said no/)
      await assert.rejects(server.wait(), /User said no/)
    } finally {
      server.close()
    }
  })

  it('rejects when the signal aborts', async () => {
    const controller = new AbortController()
    const server = await startCallbackServer({ port: 0, state: 's1', signal: controller.signal })
    try {
      controller.abort(new Error('stopped'))
      await assert.rejects(server.wait(), /stopped/)
    } finally {
      server.close()
    }
  })
})
