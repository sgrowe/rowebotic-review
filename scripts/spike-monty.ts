// Monty spike: top-level await, asyncio.gather of slow host fns, typeCheck with stubs, kwargs shape, Map conversion.
import { Monty, MontyCrashedError, MontyError, MontyRuntimeError, MontyTypingError } from '@pydantic/monty'

const stubs = `
from typing import Any, Literal, TypedDict

class Finding(TypedDict):
    file: str
    line: int

class ReviewResult(TypedDict):
    key: str
    ok: bool
    findings: list[Finding]
    error: str | None

async def jj_log(*, revset: str | None = None, limit: int | None = None) -> str:
    """Show log"""
    ...

async def jj_diff_range(*, from_: str, to: str) -> str:
    ...

async def review(*, key: str, concern: Literal["bugs", "design"], scope: str, intent: str) -> ReviewResult:
    ...
`
const pool = await Monty.create({ maxProcesses: 4 })
const session = await pool.checkout({ typeCheck: true, typeCheckStubs: stubs, limits: { maxSuspensions: 100_000, maxFeedDurationSecs: 300 } })
const calls: unknown[] = []
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const externalLookup = {
  jj_log: async (...args: unknown[]) => { calls.push(['jj_log', args]); await sleep(300); return 'log output' },
  jj_diff_range: async (...args: unknown[]) => { calls.push(['jj_diff_range', args]); return 'diff' },
  review: async (...args: unknown[]) => {
    calls.push(['review', args]); await sleep(500)
    return { key: (args.at(-1) as any).key, ok: true, findings: [{ file: 'a.ts', line: 3 }], error: null }
  },
}
let out = ''
const printCallback = (_s: string, t: string) => { out += t }
async function run(code: string) {
  out = ''
  calls.length = 0
  const t0 = Date.now()
  try {
    const value = await session.feedRun(code, { externalLookup, printCallback })
    console.log(`--- ok ${Date.now() - t0}ms value=`, value, 'type', value?.constructor?.name, '\nstdout:', JSON.stringify(out))
  } catch (e) {
    const kind = e instanceof MontyTypingError ? 'typing' : e instanceof MontyRuntimeError ? 'runtime' : e instanceof MontyCrashedError ? 'crashed' : e instanceof MontyError ? 'monty' : 'other'
    console.log(`--- ${kind} error:\n${(e as any).display ? (e as any).display(kind === 'typing' ? undefined : 'traceback') : e}`)
  }
  console.log('calls', JSON.stringify(calls, (_k, v) => v instanceof Map ? Object.fromEntries(v) : v))
}
await run(`import asyncio
r = await asyncio.gather(review(key="a", concern="bugs", scope="x", intent="y"), review(key="b", concern="design", scope="x", intent="y"))
print(len(r))
r`)
await run(`x = await jj_log(revset="@", limit=3)
y = await jj_diff_range(from_="a", to="b")
{"x": x, "n": [1, 2], "t": (1, 2), "big": 2**70}`)
await run(`x`)
await run(`await review(key="a", concern="nope", scope="x", intent="y")`)
await run(`await jj_log(revset=3)`)
await run(`raise ValueError("boom")`)
await run(`import json, re\nprint(json.dumps({"a": [1]}), re.sub("a", "b", "aaa"))`)
await run(`async def f(n):\n    return await jj_log(revset=str(n))\nimport asyncio\nawait asyncio.gather(*[f(i) for i in range(3)])`)
await session.close()
await pool.close()
