import { mkdir, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { zodToJsonSchema } from 'zod-to-json-schema'
import schemaModule from '../lib/content/schema.js'
import storeModule from '../lib/content/store.js'
import filesModule from '../lib/content/files.js'

const root = resolve(fileURLToPath(new URL('..', import.meta.url)))
const { contentFileSchema } = schemaModule
const { ContentStore } = storeModule
const { readContentSources } = filesModule
const sources = await readContentSources(join(root, '.no-external-content'), true)
const now = new Date(0)
const rows = sources.definitions.map((definition, index) => ({
  id: index + 1,
  type: definition.type,
  contentId: definition.contentId,
  version: definition.version,
  enabled: true,
  data: definition.data,
  createdAt: now,
  updatedAt: now,
}))
new ContentStore().load(rows)

const bundle = sources.definitions.map(({ type, contentId, version, data }) => ({
  type,
  contentId,
  version,
  data,
}))
const jsonSchema = zodToJsonSchema(contentFileSchema, {
  name: 'DriftContent',
  target: 'jsonSchema7',
})

await mkdir(join(root, 'lib'), { recursive: true })
await writeFile(join(root, 'lib/content.bundle.json'), `${JSON.stringify(bundle, null, 2)}\n`)
await writeFile(join(root, 'lib/drift-content.schema.json'), `${JSON.stringify(jsonSchema, null, 2)}\n`)
await writeFile(join(root, 'content/drift-content.schema.json'), `${JSON.stringify(jsonSchema, null, 2)}\n`)

console.log(`Built ${bundle.length} Drift content definitions.`)
