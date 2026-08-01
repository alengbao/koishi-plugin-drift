import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { readBuiltinContent, readContentSources } from '../src/content/files'

describe('JSON content files', () => {
  const directories: string[] = []

  afterEach(async () => {
    await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  async function externalDirectory() {
    const directory = await mkdtemp(join(tmpdir(), 'drift-files-test-'))
    directories.push(directory)
    return directory
  }

  it('reads all built-in definitions recursively', async () => {
    const builtin = await readBuiltinContent(true)
    expect(builtin.mode).toBe('source')
    expect(builtin.definitions).toHaveLength(20)
    expect(builtin.definitions.map(definition => `${definition.type}:${definition.contentId}`)).toContain('event:forest-night-glow')
  })

  it('requires external overrides to have a higher version', async () => {
    const directory = await externalDirectory()
    await mkdir(join(directory, 'nested'), { recursive: true })
    await writeFile(join(directory, 'nested', 'wood.json'), JSON.stringify({
      type: 'item',
      contentId: 'wood',
      version: 1,
      data: { name: '冲突木材', description: '', kind: 'resource', capabilities: [] },
    }))
    await expect(readContentSources(directory, true)).rejects.toThrow('必须高于内置版本')
  })

  it('rejects duplicate content ids in an external tree', async () => {
    const directory = await externalDirectory()
    const definition = {
      type: 'item',
      contentId: 'custom-item',
      version: 1,
      data: { name: '测试物品', description: '', kind: 'resource', capabilities: [] },
    }
    await mkdir(join(directory, 'a'), { recursive: true })
    await mkdir(join(directory, 'b'), { recursive: true })
    await writeFile(join(directory, 'a', 'item.json'), JSON.stringify(definition))
    await writeFile(join(directory, 'b', 'item.json'), JSON.stringify(definition))
    await expect(readContentSources(directory, true)).rejects.toThrow('同时出现在')
  })
})
