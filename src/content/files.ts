import { randomUUID } from 'node:crypto'
import { access, copyFile, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve } from 'node:path'
import type { ContentType } from '../core/types'
import type { ContentFileDefinition } from './schema'
import { contentFileSchema } from './schema'

export interface ContentSourceSet {
  definitions: ContentFileDefinition[]
  builtinCount: number
  externalCount: number
  builtinMode: 'source' | 'bundle'
}

const typeDirectories: Record<ContentType, string> = {
  region: 'regions',
  item: 'items',
  enemy: 'enemies',
  building: 'buildings',
  location: 'locations',
  event: 'events',
}

export function contentKey(definition: Pick<ContentFileDefinition, 'type' | 'contentId'>) {
  return `${definition.type}:${definition.contentId}`
}

export function builtinSourceDir() {
  return resolve(__dirname, '../../content')
}

export function builtinBundlePath() {
  return resolve(__dirname, '../content.bundle.json')
}

export function builtinSchemaPath() {
  return resolve(__dirname, '../drift-content.schema.json')
}

async function exists(path: string) {
  try {
    await access(path)
    return true
  } catch {
    return false
  }
}

async function jsonFiles(root: string): Promise<string[]> {
  if (!await exists(root)) return []
  const result: string[] = []
  const visit = async (directory: string) => {
    const entries = await readdir(directory, { withFileTypes: true })
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else if (entry.isFile() && entry.name.endsWith('.json') && entry.name !== 'drift-content.schema.json') result.push(path)
    }
  }
  await visit(root)
  return result
}

function parseDefinition(value: unknown, owner: string): ContentFileDefinition {
  const parsed = contentFileSchema.safeParse(value)
  if (!parsed.success) throw new Error(`内容文件 ${owner} 校验失败：${parsed.error.message}`)
  return parsed.data
}

async function readDefinitionsFromDirectory(root: string) {
  const definitions: ContentFileDefinition[] = []
  const owners = new Map<string, string>()
  for (const path of await jsonFiles(root)) {
    let value: unknown
    try {
      value = JSON.parse(await readFile(path, 'utf8'))
    } catch (error) {
      throw new Error(`无法解析内容文件 ${relative(root, path)}：${(error as Error).message}`)
    }
    const owner = relative(root, path)
    const definition = parseDefinition(value, owner)
    const key = contentKey(definition)
    if (owners.has(key)) throw new Error(`内容 ${key} 同时出现在 ${owners.get(key)} 和 ${owner}`)
    owners.set(key, owner)
    definitions.push(definition)
  }
  return definitions
}

async function readDefinitionsFromBundle(path: string) {
  let values: unknown
  try {
    values = JSON.parse(await readFile(path, 'utf8'))
  } catch (error) {
    throw new Error(`无法解析内置内容包 ${path}：${(error as Error).message}`)
  }
  if (!Array.isArray(values)) throw new Error(`内置内容包 ${path} 必须是数组`)
  const definitions = values.map((value, index) => parseDefinition(value, `bundle[${index}]`))
  const keys = new Set<string>()
  for (const definition of definitions) {
    const key = contentKey(definition)
    if (keys.has(key)) throw new Error(`内置内容包包含重复内容 ${key}`)
    keys.add(key)
  }
  return definitions
}

export async function readBuiltinContent(preferSource: boolean) {
  const sourceDir = builtinSourceDir()
  const bundlePath = builtinBundlePath()
  const sourceExists = await exists(sourceDir)
  const bundleExists = await exists(bundlePath)
  const useSource = sourceExists && (preferSource || !bundleExists)
  const builtin = useSource
    ? await readDefinitionsFromDirectory(sourceDir)
    : bundleExists
      ? await readDefinitionsFromBundle(bundlePath)
      : await readDefinitionsFromDirectory(sourceDir)
  if (!builtin.length) throw new Error('没有找到内置 Drift 内容')
  return { definitions: builtin, mode: useSource ? 'source' as const : 'bundle' as const }
}

export async function readContentSources(externalDir: string, preferSource: boolean): Promise<ContentSourceSet> {
  const builtinSource = await readBuiltinContent(preferSource)
  const builtin = builtinSource.definitions
  const external = await readDefinitionsFromDirectory(externalDir)
  const merged = new Map(builtin.map(definition => [contentKey(definition), definition]))
  for (const definition of external) {
    const key = contentKey(definition)
    const original = merged.get(key)
    if (original && definition.version <= original.version) {
      throw new Error(`外部内容 ${key} 的版本 ${definition.version} 必须高于内置版本 ${original.version}`)
    }
    merged.set(key, definition)
  }
  const definitions = [...merged.values()].sort((a, b) => contentKey(a).localeCompare(contentKey(b)))
  return {
    definitions,
    builtinCount: builtin.length,
    externalCount: external.length,
    builtinMode: builtinSource.mode,
  }
}

export async function exportContentFile(
  externalDir: string,
  definition: ContentFileDefinition,
  force: boolean,
) {
  const directory = join(externalDir, typeDirectories[definition.type])
  const filename = `${encodeURIComponent(definition.contentId)}.json`
  const path = join(directory, filename)
  if (!force && await exists(path)) throw new Error(`外部内容文件已存在：${path}`)
  await mkdir(directory, { recursive: true })

  const sourceSchema = await exists(join(builtinSourceDir(), 'drift-content.schema.json'))
    ? join(builtinSourceDir(), 'drift-content.schema.json')
    : builtinSchemaPath()
  const targetSchema = join(externalDir, 'drift-content.schema.json')
  if (!await exists(targetSchema)) {
    await mkdir(dirname(targetSchema), { recursive: true })
    await copyFile(sourceSchema, targetSchema)
  }

  const output = {
    $schema: '../drift-content.schema.json',
    ...definition,
  }
  const temporary = `${path}.${randomUUID()}.tmp`
  await writeFile(temporary, `${JSON.stringify(output, null, 2)}\n`, 'utf8')
  await rename(temporary, path)
  return path
}
