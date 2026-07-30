import type { DriftContent } from '../storage/schema'
import type { BuildingData, ContentDefinition, EnemyData, EventData, ItemData, RegionData } from './schema'
import { contentDefinitionSchema } from './schema'
import type { ContentType } from '../core/types'

export class ContentStore {
  private regions = new Map<string, RegionData>()
  private items = new Map<string, ItemData>()
  private enemies = new Map<string, EnemyData>()
  private buildings = new Map<string, BuildingData>()
  private events = new Map<string, EventData>()
  private versions = new Map<string, number>()

  load(rows: DriftContent[]) {
    this.regions.clear()
    this.items.clear()
    this.enemies.clear()
    this.buildings.clear()
    this.events.clear()
    this.versions.clear()

    for (const row of rows) {
      if (!row.enabled) continue
      const parsed = contentDefinitionSchema.safeParse({
        type: row.type,
        contentId: row.contentId,
        data: row.data,
      })
      if (!parsed.success) {
        throw new Error(`内容 ${row.type}:${row.contentId} 校验失败：${parsed.error.message}`)
      }
      this.put(parsed.data)
      this.versions.set(`${row.type}:${row.contentId}`, row.version)
    }
    this.validateReferences()
  }

  private put(definition: ContentDefinition) {
    switch (definition.type) {
      case 'region': this.regions.set(definition.contentId, definition.data); break
      case 'item': this.items.set(definition.contentId, definition.data); break
      case 'enemy': this.enemies.set(definition.contentId, definition.data); break
      case 'building': this.buildings.set(definition.contentId, definition.data); break
      case 'event': this.events.set(definition.contentId, definition.data); break
    }
  }

  private require(map: Map<string, unknown>, type: string, id: string, owner: string) {
    if (!map.has(id)) throw new Error(`内容 ${owner} 引用了不存在或未启用的 ${type}:${id}`)
  }

  private validateReferences() {
    for (const [id, region] of this.regions) {
      for (const drop of region.collect.drops) this.require(this.items, 'item', drop.itemId, `region:${id}`)
      for (const entry of region.explore.eventPool) this.require(this.events, 'event', entry.eventId, `region:${id}`)
      for (const buildingId of region.buildingIds) this.require(this.buildings, 'building', buildingId, `region:${id}`)
    }
    for (const [id, item] of this.items) {
      for (const cost of item.recipe?.ingredients ?? []) this.require(this.items, 'item', cost.itemId, `item:${id}`)
    }
    for (const [id, enemy] of this.enemies) {
      for (const reward of enemy.rewards) this.require(this.items, 'item', reward.itemId, `enemy:${id}`)
    }
    for (const [id, building] of this.buildings) {
      for (const regionId of building.allowedRegionIds) this.require(this.regions, 'region', regionId, `building:${id}`)
      for (const cost of building.costs) this.require(this.items, 'item', cost.itemId, `building:${id}`)
    }
    for (const [id, event] of this.events) {
      for (const regionId of event.regionIds) this.require(this.regions, 'region', regionId, `event:${id}`)
      for (const choice of event.choices) {
        if (choice.outcome.type === 'gainItem') this.require(this.items, 'item', choice.outcome.itemId, `event:${id}`)
        if (choice.outcome.type === 'combat') this.require(this.enemies, 'enemy', choice.outcome.enemyId, `event:${id}`)
      }
    }
  }

  region(id: string) { return this.required(this.regions, 'region', id) }
  item(id: string) { return this.required(this.items, 'item', id) }
  enemy(id: string) { return this.required(this.enemies, 'enemy', id) }
  building(id: string) { return this.required(this.buildings, 'building', id) }
  event(id: string) { return this.required(this.events, 'event', id) }
  version(type: ContentType, id: string) { return this.required(this.versions, type, `${type}:${id}`) }

  itemEntries() { return [...this.items.entries()] }

  private required<T>(map: Map<string, T>, type: string, id: string): T {
    const value = map.get(id)
    if (!value) throw new Error(`找不到已启用的内容 ${type}:${id}`)
    return value
  }
}
