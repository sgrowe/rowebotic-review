import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, it } from 'node:test'
import { loadProject, parseFrontmatter } from '../src/config.ts'

describe('parseFrontmatter', () => {
  it('parses single-line pairs and strips quotes', () => {
    const { data, body } = parseFrontmatter('---\ndescription: Find bugs: logic errors\nwhen: "always"\n---\n\n# Bugs\n')
    assert.deepEqual(data, { description: 'Find bugs: logic errors', when: 'always' })
    assert.equal(body, '\n# Bugs\n')
  })
  it('returns the text unchanged without frontmatter', () => {
    assert.deepEqual(parseFrontmatter('# Title\n'), { data: {}, body: '# Title\n' })
  })
})

describe('loadProject', () => {
  it('loads settings, concerns, docs, instructions and prepare', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rr-config-'))
    const dir = join(root, '.rowebotic-review')
    await mkdir(join(dir, 'concerns'), { recursive: true })
    await mkdir(join(dir, 'docs'))
    await writeFile(join(dir, 'settings.json'), '{"search": "label:x"}')
    await writeFile(join(dir, 'concerns', 'design.md'), '---\ndescription: Structure\nwhen: always\n---\nDesign body\n')
    await writeFile(join(dir, 'concerns', 'bugs.md'), '---\ndescription: Bugs\nwhen: always\n---\nBugs body\n')
    await writeFile(join(dir, 'docs', 'effects.md'), 'Effects doc')
    await writeFile(join(dir, 'instructions.md'), 'Repo rules\n')
    await writeFile(join(dir, 'prepare'), '#!/bin/sh\n')
    await chmod(join(dir, 'prepare'), 0o755)
    const project = await loadProject(root)
    assert.equal(project.search, 'label:x')
    assert.deepEqual(project.concerns.map(c => [c.name, c.body]), [['bugs', 'Bugs body'], ['design', 'Design body']])
    assert.equal(project.docs.get('effects'), 'Effects doc')
    assert.equal(project.instructions, 'Repo rules')
    assert.equal(project.prepare, join(dir, 'prepare'))
  })
  it('requires description and when', async () => {
    const root = await mkdtemp(join(tmpdir(), 'rr-config-'))
    const dir = join(root, '.rowebotic-review')
    await mkdir(join(dir, 'concerns'), { recursive: true })
    await writeFile(join(dir, 'settings.json'), '{}')
    await writeFile(join(dir, 'concerns', 'bugs.md'), '---\ndescription: Bugs\n---\nbody')
    await assert.rejects(loadProject(root), /needs "description" and "when"/)
  })
})
