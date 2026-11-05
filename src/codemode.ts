// Codemode: the model's only tool is `python(code)`, run in a Monty sandbox
// session per agent. Host functions (MCP tools, review, read_doc) are async
// Python functions declared as typed stubs.

import { Monty, MontyCrashedError, MontyError, MontyTypingError, type MontySession } from '@pydantic/monty'
import type { JsonSchema, McpServer, McpTool } from './mcp.ts'

export const MAX_OUTPUT_CHARS = 120_000

const PYTHON_KEYWORDS = new Set([
  'False', 'None', 'True', 'and', 'as', 'assert', 'async', 'await', 'break', 'class', 'continue', 'def', 'del',
  'elif', 'else', 'except', 'finally', 'for', 'from', 'global', 'if', 'import', 'in', 'is', 'lambda', 'nonlocal',
  'not', 'or', 'pass', 'raise', 'return', 'try', 'while', 'with', 'yield',
])

export type CallRecord = { fn: string; args: Record<string, unknown>; ms: number; error?: string }

export type HostFunction = {
  /** Python name. */
  name: string
  /** `async def ...` stub with docstring. */
  stub: string
  /** Called with keyword args (Python names already mapped back, `None` optionals dropped). */
  call: (args: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>
}

export function pythonName(name: string): string {
  let id = name.replace(/[^A-Za-z0-9_]/g, '_')
  if (/^[0-9]/.test(id)) id = `_${id}`
  if (PYTHON_KEYWORDS.has(id)) id = `${id}_`
  return id
}

function literal(value: unknown): string {
  if (value === null) return 'None'
  if (value === true) return 'True'
  if (value === false) return 'False'
  return JSON.stringify(value)
}

/** JSON schema → Python type annotation. */
export function pythonType(schema: JsonSchema | undefined): string {
  if (!schema || typeof schema !== 'object') return 'Any'
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return `Literal[${schema.enum.map(literal).join(', ')}]`
  const types = Array.isArray(schema.type) ? schema.type : schema.type ? [schema.type] : []
  if (types.length === 0) return 'Any'
  const parts = types.map(type => {
    switch (type) {
      case 'string':
        return 'str'
      case 'integer':
        return 'int'
      case 'number':
        return 'float'
      case 'boolean':
        return 'bool'
      case 'null':
        return 'None'
      case 'array':
        return `list[${schema.items ? pythonType(schema.items) : 'Any'}]`
      case 'object':
        return 'dict[str, Any]'
      default:
        return 'Any'
    }
  })
  if (parts.includes('Any')) return 'Any'
  // None last, deduplicated.
  const unique = [...new Set(parts)]
  unique.sort((a, b) => Number(a === 'None') - Number(b === 'None'))
  return unique.join(' | ')
}

function docstring(text: string, indent: string): string {
  const body = text.trim().replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')
  if (!body) return ''
  const lines = body.split('\n').map(line => (line ? indent + line : line))
  return `${indent}"""\n${lines.join('\n')}\n${indent}"""\n`
}

export type ToolStub = { name: string; stub: string; params: Map<string, string> }

/** One MCP tool → keyword-only async stub. `params` maps Python names to schema names. */
export function toolStub(tool: { name: string; description: string; inputSchema: JsonSchema }): ToolStub {
  const name = pythonName(tool.name)
  const properties = tool.inputSchema.properties ?? {}
  const required = new Set(tool.inputSchema.required ?? [])
  const params = new Map<string, string>()
  const required_: string[] = []
  const optional: string[] = []
  const argDocs: string[] = []
  for (const key of Object.keys(properties).sort()) {
    const py = pythonName(key)
    params.set(py, key)
    const schema = properties[key]
    let type = pythonType(schema)
    if (required.has(key)) {
      required_.push(`${py}: ${type}`)
    } else {
      if (type !== 'Any' && !type.split(' | ').includes('None')) type = `${type} | None`
      optional.push(`${py}: ${type} = None`)
    }
    const description = schema?.description?.trim()
    if (description) argDocs.push(`    ${py}: ${description.replace(/\n/g, '\n        ')}`)
  }
  const all = [...required_, ...optional]
  const signature = all.length ? `*, ${all.join(', ')}` : ''
  const doc = [tool.description.trim(), argDocs.length ? `Args:\n${argDocs.join('\n')}` : ''].filter(Boolean).join('\n\n')
  const stub = `async def ${name}(${signature}) -> str:\n${docstring(doc, '    ')}    ...\n`
  return { name, stub, params }
}

/** Deep-convert Monty values to plain JSON-able JS. */
export function toPlain(value: unknown): unknown {
  if (value instanceof Map) {
    const out: Record<string, unknown> = {}
    for (const [k, v] of value) out[String(k)] = toPlain(v)
    return out
  }
  if (value instanceof Set) return [...value].map(toPlain)
  if (Array.isArray(value)) return value.map(toPlain)
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(value) : value.toString()
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value)) out[k] = toPlain(v)
    return out
  }
  return value
}

/** Monty passes kwargs as a trailing object (or Map). Returns them, plain. */
export function kwargsOf(args: unknown[]): Record<string, unknown> {
  if (args.length === 0) return {}
  const last = args.at(-1)
  const isKwargs =
    last instanceof Map ||
    (last !== null && typeof last === 'object' && !Array.isArray(last) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(last)))
  if (!isKwargs || args.length > 1) {
    const error = new Error('host functions take keyword arguments only')
    error.name = 'TypeError'
    throw error
  }
  return toPlain(last) as Record<string, unknown>
}

export function mcpHostFunctions(server: McpServer, filter?: (tool: McpTool) => boolean): HostFunction[] {
  return server.tools.filter(tool => filter?.(tool) ?? true).map(tool => {
    const { name, stub, params } = toolStub(tool)
    return {
      name,
      stub,
      call: async (kwargs, signal) => {
        const args: Record<string, unknown> = {}
        for (const [key, value] of Object.entries(kwargs)) {
          if (value === null || value === undefined) continue
          args[params.get(key) ?? key] = value
        }
        return server.call(tool.name, args, signal)
      },
    }
  })
}

export const STUB_HEADER = 'from typing import Any, Literal, TypedDict\n'

/** Full stub file: header, type definitions, functions sorted by name. */
export function buildStubs(functions: HostFunction[], typeDefs = ''): string {
  const sorted = [...functions].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return [STUB_HEADER, typeDefs.trim() ? `${typeDefs.trim()}\n` : '', ...sorted.map(fn => fn.stub)].filter(Boolean).join('\n')
}

export function middleTruncate(text: string, max = MAX_OUTPUT_CHARS): string {
  if (text.length <= max) return text
  const half = Math.floor(max / 2)
  const omitted = text.length - 2 * half
  return `${text.slice(0, half)}\n\n[... ${omitted} characters omitted from the middle of ${text.length}. Filter or slice the result to see the part you need.]\n\n${text.slice(-half)}`
}

export function formatOutput(stdout: string, value: unknown): string {
  let rendered = ''
  if (value !== null && value !== undefined) {
    rendered = typeof value === 'string' ? value : JSON.stringify(toPlain(value), null, 1)
  }
  const parts = [stdout.replace(/\n$/, ''), rendered].filter(Boolean)
  return middleTruncate(parts.length ? parts.join('\n') : '(no output)')
}

export type RunResult = { output: string; error?: string; calls: CallRecord[]; durationMs: number; reset?: boolean }

export type CodeModeOptions = {
  pool: Monty
  functions: HostFunction[]
  typeDefs?: string
  signal: AbortSignal
}

/** One agent's sandbox: a Monty REPL session plus its host functions. */
export class CodeMode {
  readonly stubs: string
  #pool: Monty
  #functions: HostFunction[]
  #signal: AbortSignal
  #session: MontySession | undefined

  constructor(options: CodeModeOptions) {
    this.#pool = options.pool
    this.#functions = options.functions
    this.#signal = options.signal
    this.stubs = buildStubs(options.functions, options.typeDefs)
  }

  async #checkout(): Promise<MontySession> {
    this.#session ??= await this.#pool.checkout({
      typeCheck: true,
      typeCheckStubs: this.stubs,
      limits: { maxSuspensions: 100_000, maxFeedDurationSecs: 300 },
    })
    return this.#session
  }

  async run(code: string): Promise<RunResult> {
    const start = Date.now()
    const calls: CallRecord[] = []
    let stdout = ''
    const externalLookup: Record<string, (...args: unknown[]) => Promise<unknown>> = {}
    for (const fn of this.#functions) {
      externalLookup[fn.name] = async (...args: unknown[]) => {
        const record: CallRecord = { fn: fn.name, args: {}, ms: 0 }
        const callStart = Date.now()
        try {
          record.args = kwargsOf(args)
          return await fn.call(record.args, this.#signal)
        } catch (error) {
          record.error = String((error as Error)?.message ?? error)
          throw error
        } finally {
          record.ms = Date.now() - callStart
          calls.push(record)
        }
      }
    }
    const session = await this.#checkout()
    try {
      const value = await session.feedRun(code, {
        externalLookup,
        printCallback: (_stream, text) => {
          stdout += text
        },
      })
      return { output: formatOutput(stdout, value), calls, durationMs: Date.now() - start }
    } catch (error) {
      if (this.#signal.aborted) throw this.#signal.reason ?? error
      if (error instanceof MontyCrashedError) {
        this.#session = undefined
        await session.close().catch(() => {})
        const message = `${stdout}${error.message}\n\nThe sandbox crashed and its state was reset: variables from earlier calls are gone.`
        return { output: middleTruncate(message), error: error.message, calls, durationMs: Date.now() - start, reset: true }
      }
      if (error instanceof MontyError) {
        const text = error instanceof MontyTypingError ? error.display() : (error as MontyError & { display(f: string): string }).display('traceback')
        const output = middleTruncate(stdout ? `${stdout.replace(/\n$/, '')}\n${text}` : text)
        return { output, error: text, calls, durationMs: Date.now() - start }
      }
      throw error
    }
  }

  async close(): Promise<void> {
    const session = this.#session
    this.#session = undefined
    await session?.close().catch(() => {})
  }
}

export async function createPool(): Promise<Monty> {
  return Monty.create({ maxProcesses: 32 })
}
