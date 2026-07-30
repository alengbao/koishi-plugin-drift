import { describe, expect, it } from 'vitest'
import { ContentStore } from '../src/content/store'
import { seedContent } from '../src/content/seeds'
import type { DriftContent } from '../src/storage/schema'

function rows(): DriftContent[] {
  const now = new Date()
  return seedContent.map((seed, index) => ({
    id: index + 1,
    type: seed.type,
    contentId: seed.contentId,
    version: 1,
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
    expect(store.region('forest').name).toBe('森林')
    expect(store.item('ration').recipe?.ingredients).toEqual([{ itemId: 'wood', quantity: 2 }])
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
})
