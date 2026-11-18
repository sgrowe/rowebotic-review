import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { runHook } from '../src/hooks.ts'

test('cancelling a hook stops package-script descendants before returning', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'rowebotic-hook-'))
  try {
    const stop = new AbortController()
    const command = runHook('sh', ['-c', '(sleep 1; touch survived) & wait'], dir, stop.signal)
    setTimeout(() => stop.abort(new Error('lost lock')), 200)
    await assert.rejects(command, /lost lock/)
    await assert.rejects(import('node:fs/promises').then(fs => fs.access(join(dir, 'survived'))), { code: 'ENOENT' })
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
