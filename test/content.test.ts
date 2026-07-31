import { describe, expect, it } from 'vitest'
import { ContentStore } from '../src/content/store'
import { contentDefinitionSchema } from '../src/content/schema'
import { seedContent } from '../src/content/seeds'
import type { DriftContent } from '../src/storage/schema'

function rows(): DriftContent[] {
  const now = new Date()
  return seedContent.map((seed, index) => ({
    id: index + 1,
    type: seed.type,
    contentId: seed.contentId,
    version: seed.version,
    enabled: true,
    data: structuredClone(seed.data),
    createdAt: now,
    updatedAt: now,
  }))
}

describe('content validation', () => {
  it('loads the complete seed graph', () => {
    const store = new ContentStore()
    store.load(rows())
    expect(rows()).toHaveLength(15)
    expect(store.region('forest').name).toBe('森林')
    expect(store.item('ration').recipe?.ingredients).toEqual([{ itemId: 'wood', quantity: 2 }])
    expect(store.item('stone-axe').capabilities).toEqual(['cut-wood'])
    expect(store.enemy('wild-rat').maxHp).toBe(2)
  })

  it('rejects malformed content with its id in the error', () => {
    const content = rows()
    content.find(row => row.contentId === 'wild-rat')!.data = { name: 'broken' }
    expect(() => new ContentStore().load(content)).toThrow('enemy:wild-rat')
  })

  it('rejects missing cross-content references', () => {
    const content = rows().filter(row => row.contentId !== 'wood')
    expect(() => new ContentStore().load(content)).toThrow('item:wood')
  })

  it('rejects invalid defaults and missing tool capabilities', () => {
    const invalidDefault = rows()
    const event = invalidDefault.find(row => row.contentId === 'forest-trapped-animal')!
    for (const choice of event.data.variants[0].choices) choice.default = false
    expect(() => new ContentStore().load(invalidDefault)).toThrow('event:forest-trapped-animal')

    const missingCapability = rows()
    missingCapability.find(row => row.contentId === 'stone-axe')!.data.capabilities = []
    expect(() => new ContentStore().load(missingCapability)).toThrow('物品能力:cut-wood')
  })

  it('normalizes legacy events with a safe default choice', () => {
    const parsed = contentDefinitionSchema.parse({
      type: 'event',
      contentId: 'legacy-event',
      data: {
        name: '旧事件',
        description: '旧格式内容',
        regionIds: ['forest'],
        choices: [
          { id: 'inspect', label: '调查', outcome: { type: 'nothing', message: '调查完毕。' } },
          { id: 'leave', label: '离开', outcome: { type: 'nothing', message: '离开了。' } },
        ],
      },
    })
    if (parsed.type !== 'event') throw new Error('expected event')
    expect(parsed.data.cooldownMs).toBe(0)
    expect(parsed.data.variants[0].choices.find(choice => choice.default)?.id).toBe('leave')
  })
})
