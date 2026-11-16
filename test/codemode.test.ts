import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { after, before, describe, it } from 'node:test'
import type { Monty } from '@pydantic/monty'
import {
  buildStubs,
  CodeMode,
  createPool,
  formatOutput,
  type HostFunction,
  kwargsOf,
  MAX_OUTPUT_CHARS,
  mcpHostFunctions,
  middleTruncate,
  pythonType,
  toolStub,
} from '../src/codemode.ts'
import type { McpServer, McpTool } from '../src/mcp.ts'

const fixture = JSON.parse(readFileSync(new URL('./fixtures/tools.json', import.meta.url), 'utf8')) as Record<string, { tools: McpTool[] }>

function fakeServer(name: string, calls: { tool: string; args: Record<string, unknown> }[]): McpServer {
  return {
    name,
    tools: fixture[name]!.tools,
    call: async (tool: string, args: Record<string, unknown>) => {
      calls.push({ tool, args })
      if (tool === 'jj_help') throw new Error('jj failed\nexit code: 1')
      return `${tool} ok`
    },
  } as unknown as McpServer
}

describe('pythonType', () => {
  it('maps JSON schema types', () => {
    assert.equal(pythonType({ type: 'string' }), 'str')
    assert.equal(pythonType({ type: ['integer', 'null'] }), 'int | None')
    assert.equal(pythonType({ type: 'number' }), 'float')
    assert.equal(pythonType({ type: 'array', items: { type: 'string' } }), 'list[str]')
    assert.equal(pythonType({ type: 'array' }), 'list[Any]')
    assert.equal(pythonType({ type: 'object' }), 'dict[str, Any]')
    assert.equal(pythonType({ type: 'string', enum: ['LEFT', 'RIGHT'] }), 'Literal["LEFT", "RIGHT"]')
    assert.equal(pythonType({ $ref: '#/x' }), 'Any')
    assert.equal(pythonType({ anyOf: [] }), 'Any')
  })
})

describe('toolStub', () => {
  it('renames Python keywords and keeps params keyword-only', () => {
    const tool = fixture.jj!.tools.find(t => t.name === 'jj_diff_range')!
    const { stub, params } = toolStub(tool)
    assert.match(stub, /^async def jj_diff_range\(\*, from_: str, to: str, context: int \| None = None,/)
    assert.equal(params.get('from_'), 'from')
  })
  it('omits the bare * for tools without params', () => {
    const tool = fixture.psql!.tools.find(t => t.name === 'psql_list_tables')!
    assert.match(toolStub(tool).stub, /^async def psql_list_tables\(\) -> str:/)
  })
})

describe('kwargsOf', () => {
  it('accepts plain, null-prototype and Map kwargs', () => {
    assert.deepEqual(kwargsOf([{ a: 1 }]), { a: 1 })
    assert.deepEqual(kwargsOf([Object.assign(Object.create(null), { a: 1 })]), { a: 1 })
    assert.deepEqual(kwargsOf([new Map([['a', new Map([['b', 2n]])]])]), { a: { b: 2 } })
    assert.deepEqual(kwargsOf([]), {})
  })
  it('rejects positional args', () => {
    assert.throws(() => kwargsOf(['x']), { name: 'TypeError' })
  })
})

describe('output', () => {
  it('formats stdout and the last value', () => {
    assert.equal(formatOutput('', null), '(no output)')
    assert.equal(formatOutput('hi\n', 'text'), 'hi\ntext')
    assert.equal(formatOutput('', new Map([['a', [1n]]])), '{\n "a": [\n  1\n ]\n}')
  })
  it('middle-truncates long output', () => {
    const text = 'a'.repeat(100) + 'b'.repeat(100)
    const out = middleTruncate(text, 50)
    assert.ok(out.startsWith('a'.repeat(25)))
    assert.ok(out.endsWith('b'.repeat(25)))
    assert.match(out, /150 characters omitted/)
  })
  it('states the output limit in the prompt', () => {
    const prompt = readFileSync(new URL('../src/prompts/codemode.md', import.meta.url), 'utf8')
    assert.ok(prompt.includes(MAX_OUTPUT_CHARS.toLocaleString('en-US')))
  })
})

describe('CodeMode with Monty', () => {
  let pool: Monty
  before(async () => {
    pool = await createPool()
  })
  after(async () => {
    await pool.close()
  })

  it('type-checks real tool stubs and calls tools with original names', async () => {
    const calls: { tool: string; args: Record<string, unknown> }[] = []
    const functions = [
      ...mcpHostFunctions(fakeServer('jj', calls)),
      ...mcpHostFunctions(fakeServer('psql', calls)),
      ...mcpHostFunctions(fakeServer('github', calls)),
    ]
    const codemode = new CodeMode({ pool, functions, signal: new AbortController().signal })
    try {
      const result = await codemode.run(
        [
          'import asyncio',
          'a, b = await asyncio.gather(jj_diff_range(from_="x", to="y", name_only=True), psql_list_tables())',
          'await pull_request_review_write(method="create", owner="o", repo="r", pullNumber=3)',
          'print(a)',
          '{"b": b}',
        ].join('\n'),
      )
      assert.equal(result.error, undefined, result.output)
      assert.equal(result.output, 'jj_diff_range ok\n{\n "b": "psql_list_tables ok"\n}')
      assert.deepEqual(calls[0], { tool: 'jj_diff_range', args: { from: 'x', to: 'y', name_only: true } })
      assert.deepEqual(calls[2], { tool: 'pull_request_review_write', args: { method: 'create', owner: 'o', repo: 'r', pullNumber: 3 } })
      assert.equal(result.calls.length, 3)

      const typo = await codemode.run('await jj_show(revision="@")')
      assert.match(typo.error ?? '', /jj_show/)

      const failing = await codemode.run('await jj_help(topic="revsets")')
      assert.match(failing.output, /RuntimeError: jj failed/)
      assert.equal(failing.calls[0]!.error, 'jj failed\nexit code: 1')

      // REPL state persists across runs.
      await codemode.run('saved = 41')
      assert.equal((await codemode.run('saved + 1')).output, '42')
    } finally {
      await codemode.close()
    }
  })

  it('accepts TypedDict and Literal stubs for custom host functions', async () => {
    const review: HostFunction = {
      name: 'review',
      stub: 'async def review(*, key: str, concern: Literal["bugs", "design"]) -> ReviewResult:\n    ...\n',
      call: async args => ({ key: args.key, ok: true, findings: [], error: null }),
    }
    const typeDefs = 'class ReviewResult(TypedDict):\n    key: str\n    ok: bool\n    findings: list[dict[str, Any]]\n    error: str | None\n'
    assert.match(buildStubs([review], typeDefs), /^from typing import Any, Literal, TypedDict\n/)
    const codemode = new CodeMode({ pool, functions: [review], typeDefs, signal: new AbortController().signal })
    try {
      const ok = await codemode.run('r = await review(key="k", concern="bugs")\nr["ok"]')
      assert.equal(ok.output, 'true')
      const bad = await codemode.run('await review(key="k", concern="nope")')
      assert.match(bad.error ?? '', /Literal/)
    } finally {
      await codemode.close()
    }
  })
})

describe('shared pool cancellation', () => {
  it('rejects a cancelled checkout promptly and closes a late session without executing it', async () => {
    let release!: (session: unknown) => void
    let closes = 0
    let runs = 0
    const pool = { checkout: () => new Promise(resolve => { release = resolve }) } as unknown as Monty
    const controller = new AbortController()
    const mode = new CodeMode({ pool, functions: [], signal: controller.signal })
    const running = mode.run('1')
    controller.abort(new Error('cancelled'))
    await assert.rejects(running, /cancelled/)
    await mode.close()
    release({ close: async () => { closes++ }, feedRun: async () => { runs++ } })
    await new Promise(resolve => setImmediate(resolve))
    assert.equal(closes, 1)
    assert.equal(runs, 0)
  })

  it('keeps sessions isolated and releases capacity after a peer closes', async () => {
    const pool = await createPool(2)
    const first = new CodeMode({ pool, functions: [], signal: new AbortController().signal })
    const second = new CodeMode({ pool, functions: [], signal: new AbortController().signal })
    const third = new CodeMode({ pool, functions: [], signal: new AbortController().signal })
    try {
      await first.run('secret = 123')
      assert.ok((await second.run('secret')).error)
      const queued = third.run('42')
      await first.close()
      assert.equal((await queued).output, '42')
      assert.equal((await second.run('7')).output, '7')
    } finally {
      await Promise.all([first.close(), second.close(), third.close()])
      await pool.close()
    }
  })
})
