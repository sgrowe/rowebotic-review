// Project files in the reviewed repo, under .rowebotic-review/.

import { access, constants, readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'

export const PROJECT_DIR = '.rowebotic-review'

export type Concern = {
  name: string
  description: string
  when: string
  /** Instructions for the reviewer, sent in its first message. */
  body: string
}

export type ProjectConfig = {
  root: string
  /** gh search qualifiers for `watch`. */
  search: string | undefined
  concerns: Concern[]
  /** Doc name (file name without `.md`) → text. */
  docs: Map<string, string>
  /** Appended to both agents' instructions. */
  instructions: string
  /** Path to `prepare` if it is executable. */
  prepare: string | undefined
}

/** Parses `---` frontmatter with single-line `key: value` pairs. Values may be quoted. */
export function parseFrontmatter(text: string): { data: Record<string, string>; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text)
  if (!match) return { data: {}, body: text }
  const data: Record<string, string> = {}
  for (const line of match[1]!.split(/\r?\n/)) {
    const pair = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (!pair) continue
    let value = pair[2]!.trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.length >= 2 ? value.slice(1, -1) : value
    }
    data[pair[1]!] = value
  }
  return { data, body: text.slice(match[0].length) }
}

async function readOptional(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}

async function markdownFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(dir)).filter(name => name.endsWith('.md')).sort()
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return []
    throw error
  }
}

export async function loadProject(root: string): Promise<ProjectConfig> {
  const dir = join(root, PROJECT_DIR)
  const settingsText = await readOptional(join(dir, 'settings.json'))
  if (settingsText === undefined) throw new Error(`Missing ${join(dir, 'settings.json')}; run from the repo root`)
  const settings = JSON.parse(settingsText) as { search?: unknown }
  if (settings.search !== undefined && typeof settings.search !== 'string') throw new Error('settings.json: "search" must be a string')

  const concerns: Concern[] = []
  for (const file of await markdownFiles(join(dir, 'concerns'))) {
    const name = basename(file, '.md')
    if (!/^[A-Za-z0-9_-]+$/.test(name)) throw new Error(`Concern file name must be [A-Za-z0-9_-]: ${file}`)
    const { data, body } = parseFrontmatter(await readFile(join(dir, 'concerns', file), 'utf8'))
    if (!data.description || !data.when) throw new Error(`concerns/${file}: frontmatter needs "description" and "when"`)
    concerns.push({ name, description: data.description, when: data.when, body: body.trim() })
  }
  if (concerns.length === 0) throw new Error(`No concerns in ${join(dir, 'concerns')}`)

  const docs = new Map<string, string>()
  for (const file of await markdownFiles(join(dir, 'docs'))) {
    docs.set(basename(file, '.md'), await readFile(join(dir, 'docs', file), 'utf8'))
  }

  const prepare = join(dir, 'prepare')
  let executable = false
  try {
    await access(prepare, constants.X_OK)
    executable = true
  } catch {
    executable = false
  }

  return {
    root,
    search: settings.search,
    concerns,
    docs,
    instructions: ((await readOptional(join(dir, 'instructions.md'))) ?? '').trim(),
    prepare: executable ? prepare : undefined,
  }
}
