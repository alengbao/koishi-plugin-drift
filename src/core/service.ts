import { $, Context, Service } from 'koishi'
import { isDeepStrictEqual } from 'node:util'
import { ContentStore } from '../content/store'
import {
  contentKey,
  exportContentFile,
  readBuiltinContent,
  readContentSources,
} from '../content/files'
import type { ContentSourceSet } from '../content/files'
import type { ContentFileDefinition } from '../content/schema'
import type {
  BuildingData,
  EventCondition,
  EventData,
  EventEffect,
  EventVariant,
  ItemData,
  RegionData,
} from '../content/schema'
import type {
  ActionOption,
  ActorIdentity,
  CampView,
  CharacterHistory,
  CharacterSnapshot,
  ContentReport,
  ContentType,
  DeathCause,
  GameResult,
  GameSnapshot,
  InventoryView,
  PendingOption,
} from './types'
import type {
  DriftCharacter,
  DriftCharacterEvent,
  DriftContent,
  DriftIdentity,
  DriftPendingChoice,
  DriftUser,
} from '../storage/schema'

type DriftDatabase = Context['database']

export interface DriftServiceOptions {
  now?: () => Date
  random?: () => number
  choiceTimeout?: number
  contentDir?: string
}

declare module 'koishi' {
  interface Context {
    drift: DriftService
  }
}

export class DriftService extends Service {
  private readonly content = new ContentStore()
  private readonly now: () => Date
  private readonly random: () => number
  private readonly choiceTimeout: number
  private readonly contentDir: string

  constructor(ctx: Context, options: DriftServiceOptions = {}) {
    super(ctx, 'drift', true)
    this.now = options.now ?? (() => new Date())
    this.random = options.random ?? Math.random
    this.choiceTimeout = options.choiceTimeout ?? 5 * 60 * 1000
    this.contentDir = options.contentDir ?? `${ctx.baseDir}/data/drift/content`
  }

  protected async start() {
    const builtin = await readBuiltinContent(false)
    const now = this.now()
    for (const seed of builtin.definitions) {
      const [existing] = await this.ctx.database.get('drift_content', {
        type: seed.type,
        contentId: seed.contentId,
      })
      if (!existing) {
        await this.ctx.database.create('drift_content', {
          type: seed.type,
          contentId: seed.contentId,
          version: seed.version,
          enabled: true,
          data: seed.data,
          createdAt: now,
          updatedAt: now,
        })
      } else if (existing.version < seed.version) {
        // Seed updates are explicit: bump the seed version to replace its data.
        // Keep an administrator's enabled/disabled choice intact.
        await this.ctx.database.set('drift_content', { id: existing.id }, {
          version: seed.version,
          data: seed.data,
          updatedAt: now,
        })
      }
    }
    const rows = await this.ctx.database.get('drift_content', {})
    this.content.load(rows)
  }

  async createCharacter(actor: ActorIdentity, name: string | undefined, requestId: string): Promise<GameResult> {
    const normalizedName = this.normalizeName(name)
    if (!normalizedName.ok) return normalizedName.result

    return this.transact(async (db) => {
      const user = await this.resolveUser(db, actor)
      const repeated = await this.repeatedResult(db, user.id, requestId)
      if (repeated) return repeated
      const active = await this.activeCharacter(db, user)
      if (active) return this.failure('active-character-exists', `你已经有存活角色“${active.name}”。`)

      const now = this.now()
      const character = await db.create('drift_character', {
        userId: user.id,
        name: normalizedName.name,
        status: 'active',
        speciesId: 'human',
        professionId: 'drifter',
        regionId: 'forest',
        hp: 3,
        maxHp: 3,
        attack: 1,
        actionPoints: 3,
        maxActionPoints: 3,
        apDate: this.localDate(now),
        provisionDate: null,
        hungerDays: 0,
        revision: 0,
        deathCause: null,
        deathDetail: null,
        diedAt: null,
        createdAt: now,
        updatedAt: now,
      })
      await db.create('drift_inventory', {
        characterId: character.id,
        itemId: 'ration',
        quantity: 1,
        updatedAt: now,
      })
      await db.set('drift_user', { id: user.id }, {
        activeCharacterId: character.id,
        revision: user.revision + 1,
        updatedAt: now,
      })
      const result = this.success('character-created', `“${character.name}”醒在森林边缘，背包里只有 1 份口粮。`, {
        character: this.characterSnapshot(character),
      })
      await this.log(db, requestId, user.id, character.id, 'create', { name: character.name }, result)
      return result
    })
  }

  async getStatus(actor: ActorIdentity): Promise<GameSnapshot> {
    return this.transact(async (db) => {
      const user = await this.resolveUser(db, actor)
      const character = await this.activeCharacter(db, user)
      if (!character) return { character: null }
      await this.refreshActionPoints(db, character)
      const pending = await this.pendingChoice(db, character.id)
      return {
        character: this.characterSnapshot(character),
        pendingTitle: pending ? this.pendingTitle(pending) : undefined,
        pendingExpiresAt: pending ? this.choiceExpiresAt(pending) : undefined,
      }
    })
  }

  async listActions(actor: ActorIdentity): Promise<ActionOption[]> {
    return this.transact(async (db) => {
      const user = await this.resolveUser(db, actor)
      const character = await this.activeCharacter(db, user)
      if (!character) return []
      await this.refreshActionPoints(db, character)
      const pending = await this.pendingChoice(db, character.id)
      if (pending) {
        return pending.options.map((option, index) => ({
          index: index + 1,
          actionId: `choice:${option.id}`,
          label: option.label,
          enabled: option.enabled !== false,
          disabledReason: option.disabledReason,
          apCost: 0,
        }))
      }

      const inventory = await this.inventoryMap(db, character.id)
      const buildings = await db.get('drift_character_building', { characterId: character.id })
      const region = this.content.region(character.regionId)
      const shelter = this.content.building('shelter')
      const actions: ActionOption[] = [
        this.option(1, 'collect', '收集资源', region.collect.apCost, character),
        this.option(2, 'explore', `探索${region.name}`, region.explore.apCost, character),
      ]
      for (const [itemId, item] of this.content.craftableItems()) {
        actions.push(this.option(
          actions.length + 1,
          `craft:${itemId}`,
          `制作${item.name}`,
          item.recipe!.apCost,
          character,
          this.missingCosts(item.recipe!.ingredients, inventory),
        ))
      }
      actions.push(this.option(
        actions.length + 1,
        'build:shelter',
        '建造庇护所',
        shelter.apCost,
        character,
        buildings.some(row => row.regionId === character.regionId && row.buildingId === 'shelter')
          ? '已经建造过庇护所'
          : this.missingCosts(shelter.costs, inventory),
      ))
      return actions
    })
  }

  async executeAction(actor: ActorIdentity, actionId: string, requestId: string): Promise<GameResult> {
    return this.transact(async (db) => {
      const user = await this.resolveUser(db, actor)
      const repeated = await this.repeatedResult(db, user.id, requestId)
      if (repeated) return repeated
      const character = await this.activeCharacter(db, user)
      if (!character) return this.failure('no-active-character', '你还没有存活角色，请先创建角色。')
      await this.refreshActionPoints(db, character)
      const pendingState = await this.pendingChoiceState(db, character.id)
      if (pendingState.expired && pendingState.pending) {
        return this.settleChoice(db, user, character, pendingState.pending, this.defaultOption(pendingState.pending), requestId, true)
      }
      if (pendingState.pending) {
        return this.failure('pending-choice', '请先处理当前选择。')
      }

      const inventory = await this.inventoryMap(db, character.id)
      const prepared = await this.prepareAction(db, character, actionId, inventory)
      if (!prepared.ok) return prepared.result

      const provision = await this.settleProvision(db, user, character, inventory)
      if (!provision.alive) {
        await this.log(db, requestId, user.id, character.id, actionId, {}, provision.result)
        return provision.result
      }

      const actionResult = await this.applyAction(db, user, character, actionId, prepared.region, prepared.item, prepared.building, inventory)
      const result = {
        ...actionResult,
        message: [provision.message, actionResult.message].filter(Boolean).join('\n'),
      }
      await this.log(db, requestId, user.id, character.id, actionId, {}, result)
      return result
    })
  }

  async resolveChoice(actor: ActorIdentity, optionId: string, requestId: string): Promise<GameResult> {
    return this.transact(async (db) => {
      const user = await this.resolveUser(db, actor)
      const repeated = await this.repeatedResult(db, user.id, requestId)
      if (repeated) return repeated
      const character = await this.activeCharacter(db, user)
      if (!character) return this.failure('no-active-character', '你还没有存活角色，请先创建角色。')
      const state = await this.pendingChoiceState(db, character.id)
      if (state.expired && state.pending) {
        return this.settleChoice(db, user, character, state.pending, this.defaultOption(state.pending), requestId, true)
      }
      const pending = state.pending
      if (!pending) return this.failure('no-pending-choice', '当前没有需要处理的选择。')
      const option = pending.options.find(entry => entry.id === optionId)
      if (!option) return this.failure('invalid-choice', '没有这个选项。')
      if (option.enabled === false) return this.failure('requirements-not-met', option.disabledReason ?? '这个选项当前不可用。')
      return this.settleChoice(db, user, character, pending, option, requestId)
    })
  }

  async settleExpiredChoice(actor: ActorIdentity, requestId: string): Promise<GameResult | null> {
    return this.transact(async (db) => {
      const [identity] = await db.get('drift_identity', {
        platform: actor.platform,
        platformUserId: actor.platformUserId,
      })
      if (!identity) return null
      const [user] = await db.get('drift_user', { id: identity.userId })
      if (!user) return null
      const repeated = await this.repeatedResult(db, user.id, requestId)
      if (repeated) return repeated
      const character = await this.activeCharacter(db, user)
      if (!character) return null
      const state = await this.pendingChoiceState(db, character.id)
      if (!state.expired || !state.pending) return null
      return this.settleChoice(db, user, character, state.pending, this.defaultOption(state.pending), requestId, true)
    })
  }

  async resolveChoiceByIndex(
    actor: ActorIdentity,
    index: number,
    requestId: string,
  ): Promise<GameResult | null> {
    return this.transact(async (db) => {
      const [identity] = await db.get('drift_identity', {
        platform: actor.platform,
        platformUserId: actor.platformUserId,
      })
      if (!identity) return null
      const [user] = await db.get('drift_user', { id: identity.userId })
      if (!user) throw new Error(`身份 ${identity.id} 对应的游戏用户不存在`)
      const repeated = await this.repeatedResult(db, user.id, requestId)
      if (repeated) return repeated
      const character = await this.activeCharacter(db, user)
      if (!character) return null

      const state = await this.pendingChoiceState(db, character.id)
      if (state.expired && state.pending) {
        return this.settleChoice(db, user, character, state.pending, this.defaultOption(state.pending), requestId, true)
      }
      const pending = state.pending
      if (!pending) return null
      const option = pending.options[index - 1]
      if (!option) return this.failure('invalid-choice', '没有这个选项，请直接发送列表中的数字。')
      if (option.enabled === false) return this.failure('requirements-not-met', option.disabledReason ?? '这个选项当前不可用。')
      return this.settleChoice(db, user, character, pending, option, requestId)
    })
  }

  async getInventory(actor: ActorIdentity): Promise<InventoryView> {
    return this.transact(async (db) => {
      const user = await this.resolveUser(db, actor)
      const character = await this.activeCharacter(db, user)
      if (!character) return { characterId: null, items: [] }
      const rows = await db.get('drift_inventory', { characterId: character.id })
      return {
        characterId: character.id,
        items: rows.map(row => ({
          itemId: row.itemId,
          name: this.content.item(row.itemId).name,
          quantity: row.quantity,
        })).sort((a, b) => a.itemId.localeCompare(b.itemId)),
      }
    })
  }

  async getCamp(actor: ActorIdentity): Promise<CampView> {
    return this.transact(async (db) => {
      const user = await this.resolveUser(db, actor)
      const character = await this.activeCharacter(db, user)
      if (!character) return { characterId: null, buildings: [] }
      const rows = await db.get('drift_character_building', { characterId: character.id })
      return {
        characterId: character.id,
        buildings: rows.map(row => ({
          buildingId: row.buildingId,
          name: this.content.building(row.buildingId).name,
          regionId: row.regionId,
          level: row.level,
        })),
      }
    })
  }

  async getHistory(actor: ActorIdentity): Promise<CharacterHistory> {
    return this.transact(async (db) => {
      const user = await this.resolveUser(db, actor)
      const query = { userId: user.id, status: 'dead' as const }
      const total = await db.eval('drift_character', row => $.count(row.id), query)
      const characters = await db.get('drift_character', query, {
        limit: 10,
        sort: { diedAt: 'desc' },
      })
      return {
        total,
        characters: characters.map(character => ({
          id: character.id,
          name: character.name,
          deathCause: character.deathCause!,
          deathDetail: character.deathDetail,
          diedAt: character.diedAt!,
        })),
      }
    })
  }

  findCraftableItem(query?: string) {
    if (!query?.trim()) return this.content.item('ration') ? 'ration' : undefined
    return this.content.findCraftableItem(query)?.[0]
  }

  craftableItems() {
    return this.content.craftableItems()
  }

  async checkContent(): Promise<ContentReport> {
    try {
      const sources = await readContentSources(this.contentDir, true)
      const rows = await this.ctx.database.get('drift_content', {})
      new ContentStore().load(this.runtimeContentRows(rows, sources.definitions))
      return this.contentReport('content-valid', '内容校验通过。', sources)
    } catch (error) {
      return this.contentFailure('content-invalid', error)
    }
  }

  async loadContent(): Promise<ContentReport> {
    try {
      const sources = await readContentSources(this.contentDir, true)
      const rows = await this.ctx.database.get('drift_content', {})
      const candidate = this.runtimeContentRows(rows, sources.definitions)
      this.content.load(candidate)
      return this.contentReport('content-loaded', '内容已热加载到内存，数据库未修改。', sources)
    } catch (error) {
      return this.contentFailure('content-load-failed', error)
    }
  }

  async syncContent(): Promise<ContentReport> {
    try {
      const sources = await readContentSources(this.contentDir, true)
      let inserted = 0
      let updated = 0
      let skipped = 0
      await this.transact(async (db) => {
        const rows = await db.get('drift_content', {})
        const byKey = new Map(rows.map(row => [`${row.type}:${row.contentId}`, row]))
        const creates: ContentFileDefinition[] = []
        const updates: Array<{ row: DriftContent, definition: ContentFileDefinition }> = []
        const prospective = [...rows]

        for (const definition of sources.definitions) {
          const existing = byKey.get(contentKey(definition))
          if (!existing) {
            creates.push(definition)
            prospective.push(this.syntheticContentRow(definition, prospective.length + 1))
            inserted += 1
          } else if (definition.version > existing.version) {
            updates.push({ row: existing, definition })
            const index = prospective.findIndex(row => row.id === existing.id)
            prospective[index] = { ...existing, version: definition.version, data: definition.data }
            updated += 1
          } else if (definition.version === existing.version) {
            if (!isDeepStrictEqual(definition.data, existing.data)) {
              throw new Error(`内容 ${contentKey(definition)} 与数据库版本同为 ${definition.version}，但数据不同；请先增加版本`)
            }
            skipped += 1
          } else {
            skipped += 1
          }
        }

        new ContentStore().load(prospective)
        const now = this.now()
        for (const definition of creates) {
          await db.create('drift_content', {
            type: definition.type,
            contentId: definition.contentId,
            version: definition.version,
            enabled: true,
            data: definition.data,
            createdAt: now,
            updatedAt: now,
          })
        }
        for (const { row, definition } of updates) {
          await db.set('drift_content', { id: row.id }, {
            version: definition.version,
            data: definition.data,
            updatedAt: now,
          })
        }
      })
      this.content.load(await this.ctx.database.get('drift_content', {}))
      return {
        ...this.contentReport('content-synced', '内容已发布到数据库。', sources),
        inserted,
        updated,
        skipped,
      }
    } catch (error) {
      return this.contentFailure('content-sync-failed', error)
    }
  }

  async exportContent(type: ContentType, contentId: string, force: boolean): Promise<ContentReport> {
    try {
      const current = this.content.fileDefinition(type, contentId)
      const path = await exportContentFile(this.contentDir, {
        ...current,
        version: current.version + 1,
      }, force)
      return { ok: true, code: 'content-exported', message: `内容已导出：${path}`, path }
    } catch (error) {
      return this.contentFailure('content-export-failed', error)
    }
  }

  async resetCharacter(actor: ActorIdentity, requestId: string): Promise<GameResult> {
    return this.transact(async (db) => {
      const user = await this.resolveUser(db, actor)
      const repeated = await this.repeatedResult(db, user.id, requestId)
      if (repeated) return repeated
      const character = await this.activeCharacter(db, user)
      if (!character) return this.failure('no-active-character', '你还没有存活角色，请先创建角色。')

      const now = this.now()
      await db.remove('drift_inventory', { characterId: character.id })
      await db.remove('drift_character_building', { characterId: character.id })
      await db.remove('drift_pending_choice', { characterId: character.id })
      await db.remove('drift_character_event', { characterId: character.id })
      Object.assign(character, {
        status: 'active' as const,
        speciesId: 'human',
        professionId: 'drifter',
        regionId: 'forest',
        hp: 3,
        maxHp: 3,
        attack: 1,
        actionPoints: 3,
        maxActionPoints: 3,
        apDate: this.localDate(now),
        provisionDate: null,
        hungerDays: 0,
        deathCause: null,
        deathDetail: null,
        diedAt: null,
        updatedAt: now,
        revision: character.revision + 1,
      })
      await db.set('drift_character', { id: character.id }, {
        status: character.status,
        speciesId: character.speciesId,
        professionId: character.professionId,
        regionId: character.regionId,
        hp: character.hp,
        maxHp: character.maxHp,
        attack: character.attack,
        actionPoints: character.actionPoints,
        maxActionPoints: character.maxActionPoints,
        apDate: character.apDate,
        provisionDate: character.provisionDate,
        hungerDays: character.hungerDays,
        revision: character.revision,
        deathCause: character.deathCause,
        deathDetail: character.deathDetail,
        diedAt: character.diedAt,
        updatedAt: character.updatedAt,
      })
      await db.create('drift_inventory', {
        characterId: character.id,
        itemId: 'ration',
        quantity: 1,
        updatedAt: now,
      })
      const result = this.success('debug-reset', `“${character.name}”已恢复到初始状态。`, {
        character: this.characterSnapshot(character),
      })
      await this.log(db, requestId, user.id, character.id, 'dev:reset', {}, result)
      return result
    })
  }

  async debugGiveItem(actor: ActorIdentity, item: string, quantity: number, requestId: string): Promise<GameResult> {
    return this.transact(async (db) => {
      const user = await this.resolveUser(db, actor)
      const repeated = await this.repeatedResult(db, user.id, requestId)
      if (repeated) return repeated
      const character = await this.activeCharacter(db, user)
      if (!character) return this.failure('no-active-character', '你还没有存活角色，请先创建角色。')
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 9999) {
        return this.failure('invalid-quantity', '数量必须是 1 到 9999 的整数。')
      }
      const found = this.content.findItem(item)
      if (!found) return this.failure('unknown-item', '没有这个物品。')
      await this.adjustInventory(db, character.id, found[0], quantity)
      const result = this.success('debug-item-given', `已给予 ${quantity} 份${found[1].name}。`)
      await this.log(db, requestId, user.id, character.id, 'dev:give', { itemId: found[0], quantity }, result)
      return result
    })
  }

  async debugSetStat(
    actor: ActorIdentity,
    stat: 'hp' | 'ap',
    value: number,
    requestId: string,
  ): Promise<GameResult> {
    return this.transact(async (db) => {
      const user = await this.resolveUser(db, actor)
      const repeated = await this.repeatedResult(db, user.id, requestId)
      if (repeated) return repeated
      const character = await this.activeCharacter(db, user)
      if (!character) return this.failure('no-active-character', '你还没有存活角色，请先创建角色。')
      const maximum = stat === 'hp' ? character.maxHp : character.maxActionPoints
      const minimum = stat === 'hp' ? 1 : 0
      if (!Number.isInteger(value) || value < minimum || value > maximum) {
        return this.failure('invalid-stat', `${stat.toUpperCase()} 必须是 ${minimum} 到 ${maximum} 的整数。`)
      }
      const now = this.now()
      const field = stat === 'hp' ? 'hp' : 'actionPoints'
      character[field] = value
      character.updatedAt = now
      character.revision += 1
      await db.set('drift_character', { id: character.id }, {
        [field]: value,
        updatedAt: now,
        revision: character.revision,
      })
      const result = this.success('debug-stat-set', `已将 ${stat.toUpperCase()} 设置为 ${value}/${maximum}。`)
      await this.log(db, requestId, user.id, character.id, `dev:${stat}`, { value }, result)
      return result
    })
  }

  async debugClearEvents(actor: ActorIdentity, eventId: string | undefined, requestId: string): Promise<GameResult> {
    return this.transact(async (db) => {
      const user = await this.resolveUser(db, actor)
      const repeated = await this.repeatedResult(db, user.id, requestId)
      if (repeated) return repeated
      const character = await this.activeCharacter(db, user)
      if (!character) return this.failure('no-active-character', '你还没有存活角色，请先创建角色。')
      if (eventId) {
        try {
          this.content.event(eventId)
        } catch {
          return this.failure('unknown-event', '没有这个事件。')
        }
        await db.remove('drift_character_event', { characterId: character.id, eventId })
      } else {
        await db.remove('drift_character_event', { characterId: character.id })
      }
      const [pending] = await db.get('drift_pending_choice', { characterId: character.id })
      if (pending?.kind === 'event' && (!eventId || pending.sourceId === eventId)) {
        await db.remove('drift_pending_choice', { characterId: character.id })
      }
      const result = this.success('debug-events-cleared', eventId ? `已清除事件 ${eventId} 的进度。` : '已清除全部事件进度。')
      await this.log(db, requestId, user.id, character.id, 'dev:clear', { eventId }, result)
      return result
    })
  }

  async debugTriggerEvent(
    actor: ActorIdentity,
    eventId: string,
    variantId: string | undefined,
    requestId: string,
  ): Promise<GameResult> {
    return this.transact(async (db) => {
      const user = await this.resolveUser(db, actor)
      const repeated = await this.repeatedResult(db, user.id, requestId)
      if (repeated) return repeated
      const character = await this.activeCharacter(db, user)
      if (!character) return this.failure('no-active-character', '你还没有存活角色，请先创建角色。')
      if (await this.pendingChoice(db, character.id)) return this.failure('pending-choice', '请先处理当前选择。')
      let event: EventData
      try {
        event = this.content.event(eventId)
      } catch {
        return this.failure('unknown-event', '没有这个事件。')
      }
      const inventory = await this.inventoryMap(db, character.id)
      const opened = await this.openEventChoice(db, character, eventId, event, inventory, variantId)
      if (!opened.ok) return opened
      const result = this.success('debug-event-triggered', opened.message)
      await this.log(db, requestId, user.id, character.id, 'dev:event', { eventId, variantId }, result)
      return result
    })
  }

  async requestSuicide(actor: ActorIdentity, requestId: string): Promise<GameResult> {
    return this.transact(async (db) => {
      const user = await this.resolveUser(db, actor)
      const repeated = await this.repeatedResult(db, user.id, requestId)
      if (repeated) return repeated
      const character = await this.activeCharacter(db, user)
      if (!character) return this.failure('no-active-character', '你还没有存活角色。')
      const pendingState = await this.pendingChoiceState(db, character.id)
      if (pendingState.expired && pendingState.pending) {
        return this.settleChoice(db, user, character, pendingState.pending, this.defaultOption(pendingState.pending), requestId, true)
      }
      if (pendingState.pending) {
        const pending = pendingState.pending
        if (pending.kind === 'suicide') {
          return this.success('suicide-pending', `这个决定仍在等待确认。请在 ${this.choiceTimeoutLabel()}内直接发送 1 确认，或发送 2 取消。`)
        }
        return this.failure('pending-choice', '请先处理当前事件，再作出这个决定。')
      }

      const now = this.now()
      const options: PendingOption[] = [
        { id: 'confirm', label: '确认自尽', outcome: { type: 'suicideConfirm' }, enabled: true, default: false },
        { id: 'cancel', label: '取消', outcome: { type: 'cancel' }, enabled: true, default: true },
      ]
      await db.create('drift_pending_choice', {
        characterId: character.id,
        kind: 'suicide',
        sourceId: 'suicide',
        sourceVersion: 1,
        variantId: null,
        defaultOptionId: 'cancel',
        options,
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.choiceTimeout),
      })
      const result = this.success('suicide-pending', [
        '这个决定会永久杀死当前角色。',
        '1. 确认自尽',
        '2. 取消',
        `请在 ${this.choiceTimeoutLabel()}内直接发送数字选择。`,
      ].join('\n'))
      await this.log(db, requestId, user.id, character.id, 'suicide', {}, result)
      return result
    })
  }

  private async prepareAction(
    db: DriftDatabase,
    character: DriftCharacter,
    actionId: string,
    inventory: Map<string, number>,
  ): Promise<
    | { ok: false, result: GameResult }
    | { ok: true, region: RegionData, item?: ItemData, itemId?: string, building?: BuildingData }
  > {
    const region = this.content.region(character.regionId)
    let cost: number
    let item: ItemData | undefined
    let building: BuildingData | undefined
    let unavailable: string | undefined

    if (actionId.startsWith('craft:')) {
      const itemId = actionId.slice('craft:'.length)
      try {
        item = this.content.item(itemId)
      } catch {
        return { ok: false, result: this.failure('invalid-action', '没有这个制作配方。') }
      }
      if (!item.recipe) return { ok: false, result: this.failure('invalid-action', '这个物品不能制作。') }
      cost = item.recipe.apCost
      unavailable = this.missingCosts(item.recipe.ingredients, inventory)
    } else switch (actionId) {
      case 'collect': cost = region.collect.apCost; break
      case 'explore': cost = region.explore.apCost; break
      case 'build:shelter': {
        building = this.content.building('shelter')
        cost = building.apCost
        const [existing] = await db.get('drift_character_building', {
          characterId: character.id,
          regionId: character.regionId,
          buildingId: 'shelter',
        })
        unavailable = existing ? '已经建造过庇护所' : this.missingCosts(building.costs, inventory)
        break
      }
      default:
        return { ok: false, result: this.failure('invalid-action', '没有这个行动。') }
    }
    if (character.actionPoints < cost) {
      return { ok: false, result: this.failure('not-enough-ap', '行动点不足。') }
    }
    if (unavailable) return { ok: false, result: this.failure('requirements-not-met', unavailable) }
    return { ok: true, region, item, building }
  }

  private async applyAction(
    db: DriftDatabase,
    user: DriftUser,
    character: DriftCharacter,
    actionId: string,
    region: RegionData,
    item?: ItemData,
    building?: BuildingData,
    inventory?: Map<string, number>,
  ): Promise<GameResult> {
    let cost = 0
    let message = ''
    if (actionId === 'collect') {
      cost = region.collect.apCost
      const drop = this.pickWeighted(region.collect.drops)
      await this.adjustInventory(db, character.id, drop.itemId, drop.quantity)
      message = `你收集到了 ${drop.quantity} 份${this.content.item(drop.itemId).name}。`
    } else if (actionId === 'explore') {
      cost = region.explore.apCost
      const entries = await this.eligibleEventEntries(db, character, region, inventory ?? new Map())
      if (!entries.length) {
        await this.adjustInventory(db, character.id, 'wood', 1)
        message = '你探索了一圈，只找到 1 份木材。'
      } else {
        const entry = this.pickWeighted(entries)
        const event = this.content.event(entry.eventId)
        const opened = await this.openEventChoice(db, character, entry.eventId, event, inventory ?? new Map())
        message = opened.message
      }
    } else if (actionId.startsWith('craft:')) {
      cost = item!.recipe!.apCost
      for (const ingredient of item!.recipe!.ingredients) {
        await this.adjustInventory(db, character.id, ingredient.itemId, -ingredient.quantity)
      }
      await this.adjustInventory(db, character.id, actionId.slice('craft:'.length), item!.recipe!.outputQuantity)
      message = `你制作了 ${item!.recipe!.outputQuantity} 份${item!.name}。`
    } else if (actionId === 'build:shelter') {
      cost = building!.apCost
      for (const material of building!.costs) {
        await this.adjustInventory(db, character.id, material.itemId, -material.quantity)
      }
      const now = this.now()
      await db.create('drift_character_building', {
        characterId: character.id,
        regionId: character.regionId,
        buildingId: 'shelter',
        level: 1,
        createdAt: now,
        updatedAt: now,
      })
      message = '你建起了一座简陋的庇护所。'
    }

    character.actionPoints -= cost
    character.revision += 1
    character.updatedAt = this.now()
    await db.set('drift_character', { id: character.id }, {
      actionPoints: character.actionPoints,
      revision: character.revision,
      updatedAt: character.updatedAt,
    })
    return this.success('action-complete', message, { character: this.characterSnapshot(character) })
  }

  private async openEventChoice(
    db: DriftDatabase,
    character: DriftCharacter,
    eventId: string,
    event: EventData,
    inventory: Map<string, number>,
    variantId?: string,
  ): Promise<GameResult> {
    const forcedVariant = variantId ? event.variants.find(variant => variant.id === variantId) : undefined
    if (variantId && !forcedVariant) return this.failure('unknown-variant', `事件 ${eventId} 没有表现 ${variantId}。`)
    const now = this.now()
    const progress = await this.triggerEvent(db, character, eventId, event, now)
    const variant = forcedVariant ?? this.pickVariant(event, character, inventory, progress)
    const choices = variant.choices.map(choice => {
      const enabled = this.conditionsSatisfied(choice.conditions, character, inventory, progress)
      return {
        ...choice,
        enabled,
        disabledReason: enabled ? undefined : choice.disabledReason ?? this.conditionReason(choice.conditions),
      }
    })
    const defaultOption = choices.find(choice => choice.default)!
    await db.create('drift_pending_choice', {
      characterId: character.id,
      kind: 'event',
      sourceId: eventId,
      sourceVersion: this.content.version('event', eventId),
      variantId: variant.id,
      defaultOptionId: defaultOption.id,
      options: choices,
      createdAt: now,
      expiresAt: new Date(now.getTime() + this.choiceTimeout),
    })
    const title = variant.name ? `${event.name}·${variant.name}` : event.name
    return this.success('event-opened', [
      `${title}：${variant.description}`,
      ...choices.map((choice, index) => {
        const disabled = choice.enabled ? '' : `（不可用：${choice.disabledReason}）`
        return `${index + 1}. ${choice.label}${disabled}`
      }),
      `请在 ${this.choiceTimeoutLabel()}内直接发送数字选择。`,
    ].join('\n'))
  }

  private async settleProvision(
    db: DriftDatabase,
    user: DriftUser,
    character: DriftCharacter,
    inventory: Map<string, number>,
  ): Promise<{ alive: boolean, message: string, result: GameResult }> {
    const today = this.localDate(this.now())
    if (character.provisionDate === today) {
      return { alive: true, message: '', result: this.success('provision-settled', '') }
    }

    character.provisionDate = today
    character.revision += 1
    character.updatedAt = this.now()
    if ((inventory.get('ration') ?? 0) > 0) {
      await this.adjustInventory(db, character.id, 'ration', -1)
      inventory.set('ration', (inventory.get('ration') ?? 0) - 1)
      character.hungerDays = 0
      await db.set('drift_character', { id: character.id }, {
        provisionDate: today,
        hungerDays: 0,
        revision: character.revision,
        updatedAt: character.updatedAt,
      })
      return { alive: true, message: '今天消耗了 1 份口粮。', result: this.success('provision-settled', '') }
    }

    character.hungerDays += 1
    character.hp -= 1
    if (character.hp <= 0) {
      await this.markDead(db, user, character, 'hunger', `连续 ${character.hungerDays} 个行动日没有食物`)
      const result = this.success('character-died', `“${character.name}”因饥饿死去。`)
      return { alive: false, message: '', result }
    }
    await db.set('drift_character', { id: character.id }, {
      hp: character.hp,
      provisionDate: today,
      hungerDays: character.hungerDays,
      revision: character.revision,
      updatedAt: character.updatedAt,
    })
    return {
      alive: true,
      message: `今天没有口粮，失去 1 点生命（${character.hp}/${character.maxHp}）。`,
      result: this.success('provision-settled', ''),
    }
  }

  private async resolveCombat(
    db: DriftDatabase,
    user: DriftUser,
    character: DriftCharacter,
    enemyId: string,
  ): Promise<GameResult> {
    const enemy = this.content.enemy(enemyId)
    let enemyHp = enemy.maxHp
    let damageTaken = 0
    while (enemyHp > 0 && character.hp > 0) {
      enemyHp -= character.attack
      if (enemyHp <= 0) break
      character.hp -= enemy.attack
      damageTaken += enemy.attack
    }

    if (character.hp <= 0) {
      await this.markDead(db, user, character, 'combat', `被${enemy.name}杀死`)
      return this.success('character-died', `“${character.name}”在与${enemy.name}的战斗中死去。`)
    }
    character.revision += 1
    character.updatedAt = this.now()
    await db.set('drift_character', { id: character.id }, {
      hp: character.hp,
      revision: character.revision,
      updatedAt: character.updatedAt,
    })
    for (const reward of enemy.rewards) {
      await this.adjustInventory(db, character.id, reward.itemId, reward.quantity)
    }
    const rewards = enemy.rewards.map(reward => `${reward.quantity} 份${this.content.item(reward.itemId).name}`).join('、')
    return this.success('combat-won', `你击败了${enemy.name}，受到 ${damageTaken} 点伤害，获得${rewards}。`, {
      character: this.characterSnapshot(character),
    })
  }

  private async settleChoice(
    db: DriftDatabase,
    user: DriftUser,
    character: DriftCharacter,
    pending: DriftPendingChoice,
    option: PendingOption,
    requestId: string,
    timeout = false,
  ): Promise<GameResult> {
    if (pending.kind === 'event' && option.conditions?.length) {
      const inventory = await this.inventoryMap(db, character.id)
      const [progress] = await db.get('drift_character_event', {
        characterId: character.id,
        eventId: pending.sourceId,
      })
      if (!this.conditionsSatisfied(option.conditions, character, inventory, progress)) {
        return this.failure('requirements-not-met', option.disabledReason ?? this.conditionReason(option.conditions))
      }
    }
    let result: GameResult
    switch (option.outcome.type) {
      case 'cancel':
        result = this.success('choice-cancelled', '你取消了这次决定。')
        break
      case 'suicideConfirm':
        await this.markDead(db, user, character, 'suicide', '自行结束了旅程')
        result = this.success('character-died', `“${character.name}”结束了自己的旅程。`)
        break
      case 'nothing':
        result = this.success('event-resolved', option.outcome.message)
        break
      case 'gainItem':
        await this.adjustInventory(db, character.id, option.outcome.itemId, option.outcome.quantity)
        result = this.success('event-resolved', option.outcome.message)
        break
      case 'effects':
        result = await this.applyEventEffects(db, user, character, pending, option.outcome.effects, option.outcome.message)
        if (!result.ok) return result
        break
      case 'combat':
        result = await this.resolveCombat(db, user, character, option.outcome.enemyId)
        break
    }
    if (pending.kind === 'event') {
      await this.recordEventChoice(db, character, pending.sourceId, option.id)
    }
    await db.remove('drift_pending_choice', { characterId: character.id })
    if (timeout) {
      result = this.success('choice-timeout', `选择已超时，自动选择“${option.label}”。${result.message ? `\n${result.message}` : ''}`, result.snapshot)
    }
    await this.log(db, requestId, user.id, character.id, `choice:${option.id}`, { sourceId: pending.sourceId }, result)
    return result
  }

  private async applyEventEffects(
    db: DriftDatabase,
    user: DriftUser,
    character: DriftCharacter,
    pending: DriftPendingChoice,
    effects: EventEffect[],
    message: string,
  ): Promise<GameResult> {
    const inventory = await this.inventoryMap(db, character.id)
    const consumed = new Map<string, number>()
    for (const effect of effects) {
      if (effect.type !== 'consumeItem') continue
      consumed.set(effect.itemId, (consumed.get(effect.itemId) ?? 0) + effect.quantity)
    }
    for (const [itemId, quantity] of consumed) {
      if ((inventory.get(itemId) ?? 0) < quantity) {
        return this.failure('requirements-not-met', `缺少${quantity} 份${this.content.item(itemId).name}`)
      }
    }

    const progress = await this.getOrCreateEventProgress(db, character, pending.sourceId)
    const nextState = { ...progress.state }
    for (const effect of effects) {
      if (effect.type === 'setState') {
        nextState[effect.key] = effect.value
      } else if (effect.type === 'incrementState') {
        const current = nextState[effect.key]
        if (current !== undefined && typeof current !== 'number') {
          return this.failure('invalid-event-state', `事件状态 ${effect.key} 不是数字。`)
        }
        nextState[effect.key] = (typeof current === 'number' ? current : 0) + effect.amount
      }
    }
    let hpChanged = false
    for (const effect of effects) {
      if (effect.type === 'gainItem') {
        await this.adjustInventory(db, character.id, effect.itemId, effect.quantity)
      } else if (effect.type === 'consumeItem') {
        await this.adjustInventory(db, character.id, effect.itemId, -effect.quantity)
      } else if (effect.type === 'adjustHp') {
        character.hp = Math.max(0, Math.min(character.maxHp, character.hp + effect.amount))
        hpChanged = true
      }
    }
    progress.state = nextState
    progress.updatedAt = this.now()
    await db.set('drift_character_event', {
      characterId: character.id,
      eventId: pending.sourceId,
    }, { state: progress.state, updatedAt: progress.updatedAt })

    if (character.hp <= 0) {
      await this.markDead(db, user, character, 'event', '在探索事件中因伤势死去')
      return this.success('character-died', `“${character.name}”在探索事件中因伤势死去。`)
    }
    if (hpChanged) {
      character.revision += 1
      character.updatedAt = this.now()
      await db.set('drift_character', { id: character.id }, {
        hp: character.hp,
        revision: character.revision,
        updatedAt: character.updatedAt,
      })
    }
    return this.success('event-resolved', message, { character: this.characterSnapshot(character) })
  }

  private async recordEventChoice(db: DriftDatabase, character: DriftCharacter, eventId: string, choiceId: string) {
    const progress = await this.getOrCreateEventProgress(db, character, eventId)
    progress.lastChoiceId = choiceId
    progress.choiceCounts[choiceId] = (progress.choiceCounts[choiceId] ?? 0) + 1
    progress.updatedAt = this.now()
    await db.set('drift_character_event', { characterId: character.id, eventId }, {
      lastChoiceId: progress.lastChoiceId,
      choiceCounts: progress.choiceCounts,
      updatedAt: progress.updatedAt,
    })
  }

  private async eligibleEventEntries(
    db: DriftDatabase,
    character: DriftCharacter,
    region: RegionData,
    inventory: Map<string, number>,
  ) {
    const now = this.now().getTime()
    const result: Array<{ eventId: string, weight: number }> = []
    for (const entry of region.explore.eventPool) {
      const event = this.content.event(entry.eventId)
      const [progress] = await db.get('drift_character_event', {
        characterId: character.id,
        eventId: entry.eventId,
      })
      if (event.maxOccurrences !== undefined && (progress?.occurrenceCount ?? 0) >= event.maxOccurrences) continue
      if (progress?.cooldownUntil && progress.cooldownUntil.getTime() > now) continue
      if (!this.conditionsSatisfied(event.conditions, character, inventory, progress)) continue
      result.push(entry)
    }
    return result
  }

  private async triggerEvent(
    db: DriftDatabase,
    character: DriftCharacter,
    eventId: string,
    event: EventData,
    now: Date,
  ): Promise<DriftCharacterEvent> {
    const [existing] = await db.get('drift_character_event', {
      characterId: character.id,
      eventId,
    })
    const occurrenceCount = (existing?.occurrenceCount ?? 0) + 1
    const cooldownUntil = event.cooldownMs ? new Date(now.getTime() + event.cooldownMs) : null
    if (existing) {
      await db.set('drift_character_event', {
        characterId: character.id,
        eventId,
      }, {
        occurrenceCount,
        lastTriggeredAt: now,
        cooldownUntil,
        updatedAt: now,
      })
      return {
        ...existing,
        occurrenceCount,
        lastTriggeredAt: now,
        cooldownUntil,
        updatedAt: now,
      }
    }
    return db.create('drift_character_event', {
      characterId: character.id,
      eventId,
      occurrenceCount,
      lastTriggeredAt: now,
      cooldownUntil,
      lastChoiceId: null,
      choiceCounts: {},
      state: {},
      createdAt: now,
      updatedAt: now,
    })
  }

  private pickVariant(
    event: EventData,
    character: DriftCharacter,
    inventory: Map<string, number>,
    progress: DriftCharacterEvent,
  ): EventVariant {
    const variants = event.variants.filter(variant => (
      this.occurrenceMatches(variant, progress.occurrenceCount)
      && this.conditionsSatisfied(variant.conditions, character, inventory, progress)
    ))
    if (variants.length) return this.pickWeighted(variants)
    return event.variants.find(variant => variant.id === event.fallbackVariantId)!
  }

  private occurrenceMatches(variant: EventVariant, occurrence: number) {
    if (!variant.occurrence) return true
    if (occurrence < variant.occurrence.min) return false
    return variant.occurrence.max === undefined || occurrence <= variant.occurrence.max
  }

  private conditionsSatisfied(
    conditions: EventCondition[],
    character: DriftCharacter,
    inventory: Map<string, number>,
    progress?: DriftCharacterEvent,
  ) {
    return conditions.every(condition => {
      switch (condition.type) {
        case 'localTime':
          return this.inLocalTimeRange(condition.start, condition.end)
        case 'inventory':
          return (inventory.get(condition.itemId) ?? 0) >= condition.quantity
        case 'capability':
          return this.content.itemEntries().some(([itemId, item]) => (
            (inventory.get(itemId) ?? 0) > 0 && item.capabilities.includes(condition.capability)
          ))
        case 'hp':
          return this.compare(character.hp, condition.operator, condition.value)
        case 'eventState': {
          const value = progress?.state[condition.key]
          return value !== undefined && this.compareState(value, condition.operator, condition.value)
        }
      }
    })
  }

  private compare(actual: number, operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte', expected: number) {
    switch (operator) {
      case 'eq': return actual === expected
      case 'ne': return actual !== expected
      case 'gt': return actual > expected
      case 'gte': return actual >= expected
      case 'lt': return actual < expected
      case 'lte': return actual <= expected
    }
  }

  private compareState(actual: boolean | number | string, operator: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte', expected: boolean | number | string) {
    if (typeof actual !== typeof expected) return operator === 'ne'
    switch (operator) {
      case 'eq': return actual === expected
      case 'ne': return actual !== expected
      case 'gt': return actual > expected
      case 'gte': return actual >= expected
      case 'lt': return actual < expected
      case 'lte': return actual <= expected
    }
  }

  private conditionReason(conditions: EventCondition[]) {
    return conditions.map(condition => {
      switch (condition.type) {
        case 'localTime': return `需要在 ${condition.start}-${condition.end}`
        case 'inventory': return `需要 ${condition.quantity} 份${this.content.item(condition.itemId).name}`
        case 'capability': return `需要具备 ${condition.capability} 能力的工具`
        case 'hp': return `生命值不满足 ${condition.operator} ${condition.value}`
        case 'eventState': return `事件状态 ${condition.key} 不满足条件`
      }
    }).join('；')
  }

  private inLocalTimeRange(start: string, end: string) {
    const current = this.localTimeMinutes(this.now())
    const startMinutes = this.parseTime(start)
    const endMinutes = this.parseTime(end)
    return startMinutes <= endMinutes
      ? current >= startMinutes && current < endMinutes
      : current >= startMinutes || current < endMinutes
  }

  private localTimeMinutes(date: Date) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(date)
    const value = Object.fromEntries(parts.map(part => [part.type, part.value]))
    return Number(value.hour) * 60 + Number(value.minute)
  }

  private parseTime(value: string) {
    const [hour, minute] = value.split(':').map(Number)
    return hour * 60 + minute
  }

  private async getOrCreateEventProgress(db: DriftDatabase, character: DriftCharacter, eventId: string) {
    const [existing] = await db.get('drift_character_event', { characterId: character.id, eventId })
    if (existing) {
      existing.choiceCounts ??= {}
      existing.state ??= {}
      return existing
    }
    const now = this.now()
    return db.create('drift_character_event', {
      characterId: character.id,
      eventId,
      occurrenceCount: 0,
      lastTriggeredAt: null,
      cooldownUntil: null,
      lastChoiceId: null,
      choiceCounts: {},
      state: {},
      createdAt: now,
      updatedAt: now,
    })
  }

  private defaultOption(pending: DriftPendingChoice) {
    const option = pending.options.find(option => option.id === pending.defaultOptionId)
      ?? pending.options.find(option => option.default)
      ?? pending.options.find(option => pending.kind === 'suicide' ? option.id === 'cancel' : option.id === 'leave')
      ?? pending.options[pending.options.length - 1]
    if (!option) throw new Error(`角色 ${pending.characterId} 的待选事件没有可结算选项`)
    return option
  }

  private async markDead(
    db: DriftDatabase,
    user: DriftUser,
    character: DriftCharacter,
    cause: DeathCause,
    detail: string,
  ) {
    const now = this.now()
    character.status = 'dead'
    character.hp = Math.max(0, character.hp)
    character.deathCause = cause
    character.deathDetail = detail
    character.diedAt = now
    character.updatedAt = now
    character.revision += 1
    await db.set('drift_character', { id: character.id }, {
      status: 'dead',
      hp: character.hp,
      deathCause: cause,
      deathDetail: detail,
      diedAt: now,
      updatedAt: now,
      revision: character.revision,
    })
    await db.set('drift_user', { id: user.id }, {
      activeCharacterId: null,
      updatedAt: now,
      revision: user.revision + 1,
    })
    await db.remove('drift_pending_choice', { characterId: character.id })
  }

  private async resolveUser(db: DriftDatabase, actor: ActorIdentity): Promise<DriftUser> {
    const now = this.now()
    const [identity] = await db.get('drift_identity', {
      platform: actor.platform,
      platformUserId: actor.platformUserId,
    })
    if (identity) {
      await db.set('drift_identity', { id: identity.id }, { lastSeenAt: now })
      const [user] = await db.get('drift_user', { id: identity.userId })
      if (!user) throw new Error(`身份 ${identity.id} 对应的游戏用户不存在`)
      return user
    }

    const user = await db.create('drift_user', {
      activeCharacterId: null,
      revision: 0,
      createdAt: now,
      updatedAt: now,
    })
    await db.create('drift_identity', {
      userId: user.id,
      platform: actor.platform,
      platformUserId: actor.platformUserId,
      createdAt: now,
      lastSeenAt: now,
    })
    return user
  }

  private async activeCharacter(db: DriftDatabase, user: DriftUser): Promise<DriftCharacter | undefined> {
    if (!user.activeCharacterId) return undefined
    const [character] = await db.get('drift_character', {
      id: user.activeCharacterId,
      userId: user.id,
      status: 'active',
    })
    if (!character) throw new Error(`游戏用户 ${user.id} 的活跃角色指针无效`)
    return character
  }

  private async refreshActionPoints(db: DriftDatabase, character: DriftCharacter) {
    const today = this.localDate(this.now())
    if (character.apDate === today) return
    character.apDate = today
    character.actionPoints = character.maxActionPoints
    character.updatedAt = this.now()
    character.revision += 1
    await db.set('drift_character', { id: character.id }, {
      apDate: today,
      actionPoints: character.actionPoints,
      updatedAt: character.updatedAt,
      revision: character.revision,
    })
  }

  private async pendingChoice(db: DriftDatabase, characterId: number): Promise<DriftPendingChoice | undefined> {
    const state = await this.pendingChoiceState(db, characterId)
    return state.expired ? undefined : state.pending
  }

  private async pendingChoiceState(
    db: DriftDatabase,
    characterId: number,
  ): Promise<{ pending?: DriftPendingChoice, expired: boolean }> {
    const [pending] = await db.get('drift_pending_choice', { characterId })
    if (!pending) return { expired: false }
    if (this.choiceExpiresAt(pending).getTime() > this.now().getTime()) {
      return { pending, expired: false }
    }
    return { pending, expired: true }
  }

  private async inventoryMap(db: DriftDatabase, characterId: number) {
    const rows = await db.get('drift_inventory', { characterId })
    return new Map(rows.map(row => [row.itemId, row.quantity]))
  }

  private async adjustInventory(db: DriftDatabase, characterId: number, itemId: string, delta: number) {
    const [current] = await db.get('drift_inventory', { characterId, itemId })
    const quantity = (current?.quantity ?? 0) + delta
    if (quantity < 0) throw new Error(`角色 ${characterId} 的物品 ${itemId} 数量不足`)
    if (quantity === 0) {
      if (current) await db.remove('drift_inventory', { characterId, itemId })
      return
    }
    const updatedAt = this.now()
    if (current) {
      await db.set('drift_inventory', { characterId, itemId }, { quantity, updatedAt })
    } else {
      await db.create('drift_inventory', { characterId, itemId, quantity, updatedAt })
    }
  }

  private async repeatedResult(db: DriftDatabase, userId: number, requestId: string) {
    const [log] = await db.get('drift_action_log', { requestId })
    if (!log) return undefined
    if (log.userId !== userId) return this.failure('request-id-conflict', '请求标识已被其他用户使用。')
    return log.result
  }

  private async log(
    db: DriftDatabase,
    requestId: string,
    userId: number,
    characterId: number,
    actionId: string,
    input: Record<string, unknown>,
    result: GameResult,
  ) {
    await db.create('drift_action_log', {
      requestId,
      userId,
      characterId,
      actionId,
      input,
      result,
      createdAt: this.now(),
    })
  }

  private option(
    index: number,
    actionId: string,
    label: string,
    apCost: number,
    character: DriftCharacter,
    unavailable?: string,
  ): ActionOption {
    const disabledReason = character.actionPoints < apCost ? '行动点不足' : unavailable
    return { index, actionId, label, apCost, enabled: !disabledReason, disabledReason }
  }

  private missingCosts(costs: { itemId: string, quantity: number }[], inventory: Map<string, number>) {
    const missing = costs.filter(cost => (inventory.get(cost.itemId) ?? 0) < cost.quantity)
    if (!missing.length) return undefined
    return `缺少${missing.map(cost => `${cost.quantity} 份${this.content.item(cost.itemId).name}`).join('、')}`
  }

  private pickWeighted<T extends { weight: number }>(entries: T[]): T {
    const total = entries.reduce((sum, entry) => sum + entry.weight, 0)
    let cursor = this.random() * total
    for (const entry of entries) {
      cursor -= entry.weight
      if (cursor < 0) return entry
    }
    return entries[entries.length - 1]
  }

  private normalizeName(name?: string): { ok: true, name: string } | { ok: false, result: GameResult } {
    const normalized = name?.trim() || '流浪者'
    if ([...normalized].length > 32) {
      return { ok: false, result: this.failure('invalid-name', '角色名不能超过 32 个字符。') }
    }
    return { ok: true, name: normalized }
  }

  private pendingTitle(pending: DriftPendingChoice) {
    if (pending.kind === 'suicide') return '确认自尽'
    return this.content.event(pending.sourceId).name
  }

  private choiceExpiresAt(pending: DriftPendingChoice) {
    return pending.expiresAt ?? new Date(pending.createdAt.getTime() + this.choiceTimeout)
  }

  private choiceTimeoutLabel() {
    if (this.choiceTimeout % 60_000 === 0) return `${this.choiceTimeout / 60_000} 分钟`
    return `${Math.ceil(this.choiceTimeout / 1000)} 秒`
  }

  private characterSnapshot(character: DriftCharacter): CharacterSnapshot {
    return {
      id: character.id,
      name: character.name,
      speciesId: character.speciesId,
      professionId: character.professionId,
      regionId: character.regionId,
      hp: character.hp,
      maxHp: character.maxHp,
      actionPoints: character.actionPoints,
      maxActionPoints: character.maxActionPoints,
      hungerDays: character.hungerDays,
    }
  }

  private localDate(date: Date) {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).formatToParts(date)
    const value = Object.fromEntries(parts.map(part => [part.type, part.value]))
    return `${value.year}-${value.month}-${value.day}`
  }

  private runtimeContentRows(rows: DriftContent[], definitions: ContentFileDefinition[]) {
    const result = rows.map(row => ({ ...row }))
    const indexes = new Map(result.map((row, index) => [`${row.type}:${row.contentId}`, index]))
    for (const definition of definitions) {
      const key = contentKey(definition)
      const index = indexes.get(key)
      if (index === undefined) {
        indexes.set(key, result.length)
        result.push(this.syntheticContentRow(definition, result.length + 1))
      } else if (result[index].version <= definition.version) {
        result[index] = {
          ...result[index],
          version: definition.version,
          data: definition.data,
        }
      }
    }
    return result
  }

  private syntheticContentRow(definition: ContentFileDefinition, index: number): DriftContent {
    const now = this.now()
    return {
      id: -index,
      type: definition.type,
      contentId: definition.contentId,
      version: definition.version,
      enabled: true,
      data: definition.data,
      createdAt: now,
      updatedAt: now,
    }
  }

  private contentReport(code: string, message: string, sources: ContentSourceSet): ContentReport {
    return {
      ok: true,
      code,
      message,
      builtinCount: sources.builtinCount,
      externalCount: sources.externalCount,
      totalCount: sources.definitions.length,
      mode: sources.builtinMode,
    }
  }

  private contentFailure(code: string, error: unknown): ContentReport {
    return { ok: false, code, message: (error as Error).message }
  }

  private success(code: string, message: string, snapshot?: GameSnapshot): GameResult {
    return { ok: true, code, message, snapshot }
  }

  private failure(code: string, message: string): GameResult {
    return { ok: false, code, message }
  }

  private transact<T>(callback: (db: DriftDatabase) => Promise<T>): Promise<T> {
    return this.ctx.database.transact(callback) as Promise<T>
  }
}
