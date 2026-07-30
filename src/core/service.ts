import { $, Context, Service } from 'koishi'
import { ContentStore } from '../content/store'
import { seedContent } from '../content/seeds'
import type { BuildingData, ItemData, RegionData } from '../content/schema'
import type {
  ActionOption,
  ActorIdentity,
  CampView,
  CharacterHistory,
  CharacterSnapshot,
  DeathCause,
  GameResult,
  GameSnapshot,
  InventoryView,
  PendingOption,
} from './types'
import type {
  DriftCharacter,
  DriftIdentity,
  DriftPendingChoice,
  DriftUser,
} from '../storage/schema'

type DriftDatabase = Context['database']

export interface DriftServiceOptions {
  now?: () => Date
  random?: () => number
  choiceTimeout?: number
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

  constructor(ctx: Context, options: DriftServiceOptions = {}) {
    super(ctx, 'drift', true)
    this.now = options.now ?? (() => new Date())
    this.random = options.random ?? Math.random
    this.choiceTimeout = options.choiceTimeout ?? 5 * 60 * 1000
  }

  protected async start() {
    const now = this.now()
    for (const seed of seedContent) {
      const [existing] = await this.ctx.database.get('drift_content', {
        type: seed.type,
        contentId: seed.contentId,
      })
      if (existing) continue
      await this.ctx.database.create('drift_content', {
        type: seed.type,
        contentId: seed.contentId,
        version: 1,
        enabled: true,
        data: seed.data,
        createdAt: now,
        updatedAt: now,
      })
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
          enabled: true,
          apCost: 0,
        }))
      }

      const inventory = await this.inventoryMap(db, character.id)
      const buildings = await db.get('drift_character_building', { characterId: character.id })
      const region = this.content.region(character.regionId)
      const ration = this.content.item('ration')
      const shelter = this.content.building('shelter')
      return [
        this.option(1, 'collect', '收集木材', region.collect.apCost, character),
        this.option(2, 'explore', '探索森林', region.explore.apCost, character),
        this.option(3, 'craft:ration', '制作口粮', ration.recipe!.apCost, character,
          this.missingCosts(ration.recipe!.ingredients, inventory)),
        this.option(4, 'build:shelter', '建造庇护所', shelter.apCost, character,
          buildings.some(row => row.regionId === character.regionId && row.buildingId === 'shelter')
            ? '已经建造过庇护所'
            : this.missingCosts(shelter.costs, inventory)),
      ]
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
      if (await this.pendingChoice(db, character.id)) {
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

      const actionResult = await this.applyAction(db, character, actionId, prepared.region, prepared.item, prepared.building)
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
      if (state.expired) return this.failure('choice-expired', '这个选择已经超时，请重新发起行动。')
      const pending = state.pending
      if (!pending) return this.failure('no-pending-choice', '当前没有需要处理的选择。')
      const option = pending.options.find(entry => entry.id === optionId)
      if (!option) return this.failure('invalid-choice', '没有这个选项。')
      return this.settleChoice(db, user, character, pending, option, requestId)
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
      if (state.expired) {
        const result = this.failure('choice-expired', '这个选择已经超时，请重新发起行动。')
        await this.log(db, requestId, user.id, character.id, 'choice:expired', { index }, result)
        return result
      }
      const pending = state.pending
      if (!pending) return null
      const option = pending.options[index - 1]
      if (!option) return this.failure('invalid-choice', '没有这个选项，请直接发送列表中的数字。')
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

  async requestSuicide(actor: ActorIdentity, requestId: string): Promise<GameResult> {
    return this.transact(async (db) => {
      const user = await this.resolveUser(db, actor)
      const repeated = await this.repeatedResult(db, user.id, requestId)
      if (repeated) return repeated
      const character = await this.activeCharacter(db, user)
      if (!character) return this.failure('no-active-character', '你还没有存活角色。')
      const pending = await this.pendingChoice(db, character.id)
      if (pending) {
        if (pending.kind === 'suicide') {
          return this.success('suicide-pending', `这个决定仍在等待确认。请在 ${this.choiceTimeoutLabel()}内直接发送 1 确认，或发送 2 取消。`)
        }
        return this.failure('pending-choice', '请先处理当前事件，再作出这个决定。')
      }

      const now = this.now()
      const options: PendingOption[] = [
        { id: 'confirm', label: '确认自尽', outcome: { type: 'suicideConfirm' } },
        { id: 'cancel', label: '取消', outcome: { type: 'cancel' } },
      ]
      await db.create('drift_pending_choice', {
        characterId: character.id,
        kind: 'suicide',
        sourceId: 'suicide',
        sourceVersion: 1,
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
    | { ok: true, region: RegionData, item?: ItemData, building?: BuildingData }
  > {
    const region = this.content.region(character.regionId)
    let cost: number
    let item: ItemData | undefined
    let building: BuildingData | undefined
    let unavailable: string | undefined

    switch (actionId) {
      case 'collect': cost = region.collect.apCost; break
      case 'explore': cost = region.explore.apCost; break
      case 'craft:ration':
        item = this.content.item('ration')
        cost = item.recipe!.apCost
        unavailable = this.missingCosts(item.recipe!.ingredients, inventory)
        break
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
    character: DriftCharacter,
    actionId: string,
    region: RegionData,
    item?: ItemData,
    building?: BuildingData,
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
      const entry = this.pickWeighted(region.explore.eventPool)
      const event = this.content.event(entry.eventId)
      const now = this.now()
      await db.create('drift_pending_choice', {
        characterId: character.id,
        kind: 'event',
        sourceId: entry.eventId,
        sourceVersion: this.content.version('event', entry.eventId),
        options: event.choices,
        createdAt: now,
        expiresAt: new Date(now.getTime() + this.choiceTimeout),
      })
      message = [
        `${event.name}：${event.description}`,
        ...event.choices.map((choice, index) => `${index + 1}. ${choice.label}`),
        `请在 ${this.choiceTimeoutLabel()}内直接发送数字选择。`,
      ].join('\n')
    } else if (actionId === 'craft:ration') {
      cost = item!.recipe!.apCost
      for (const ingredient of item!.recipe!.ingredients) {
        await this.adjustInventory(db, character.id, ingredient.itemId, -ingredient.quantity)
      }
      await this.adjustInventory(db, character.id, 'ration', item!.recipe!.outputQuantity)
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
  ): Promise<GameResult> {
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
      case 'combat':
        result = await this.resolveCombat(db, user, character, option.outcome.enemyId)
        break
    }
    await db.remove('drift_pending_choice', { characterId: character.id })
    await this.log(db, requestId, user.id, character.id, `choice:${option.id}`, { sourceId: pending.sourceId }, result)
    return result
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
    return (await this.pendingChoiceState(db, characterId)).pending
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
    await db.remove('drift_pending_choice', { characterId })
    return { expired: true }
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
