import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'koishi'
import SQLite from '@koishijs/plugin-database-sqlite'
import { DriftService } from '../src/core/service'
import { ContentStore } from '../src/content/store'
import type { ActorIdentity } from '../src/core/types'
import { defineModels } from '../src/storage/schema'

const actor = (platformUserId: string): ActorIdentity => ({ platform: 'test', platformUserId })

describe('DriftService with SQLite', () => {
  const contexts: Context[] = []
  const temporaryDirectories: string[] = []

  afterEach(async () => {
    await Promise.all(contexts.splice(0).map(ctx => ctx.stop()))
    await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })))
  })

  async function createService(
    path = ':memory:',
    choiceTimeout = 5 * 60 * 1000,
    initialRandom = 0,
    contentDir?: string,
  ) {
    let current = new Date('2026-07-30T04:00:00.000Z')
    let randomValue = initialRandom
    const ctx = new Context()
    contexts.push(ctx)
    ctx.plugin(SQLite, { path })
    let service!: DriftService
    ctx.plugin({
      name: 'drift-test',
      inject: ['database'],
      apply(pluginContext: Context) {
        defineModels(pluginContext)
        service = new DriftService(pluginContext, {
          now: () => current,
          random: () => randomValue,
          choiceTimeout,
          contentDir,
        })
      },
    })
    await ctx.start()
    return {
      ctx,
      service,
      setNow(value: string) { current = new Date(value) },
      setRandom(value: number) { randomValue = value },
    }
  }

  async function activeCharacterId(ctx: Context, platformUserId: string) {
    const [identity] = await ctx.database.get('drift_identity', { platform: 'test', platformUserId })
    const [user] = await ctx.database.get('drift_user', { id: identity.userId })
    return user.activeCharacterId!
  }

  it('creates all nine tables and seeds content', async () => {
    const { ctx } = await createService()
    const tableNames = Object.keys(ctx.model.tables).filter(name => name.startsWith('drift_'))
    expect(tableNames).toHaveLength(9)
    expect(await ctx.database.get('drift_content', {})).toHaveLength(15)
  })

  it('creates a default character and makes repeated writes idempotent', async () => {
    const { service } = await createService()
    const created = await service.createCharacter(actor('one'), undefined, 'create-one')
    expect(created.message).toContain('“流浪者”')
    expect(created.message).toContain('3 份口粮')

    const first = await service.executeAction(actor('one'), 'collect', 'collect-one')
    const repeated = await service.executeAction(actor('one'), 'collect', 'collect-one')
    expect(repeated).toEqual(first)

    const inventory = await service.getInventory(actor('one'))
    expect(inventory.items).toEqual([
      { itemId: 'ration', name: '口粮', quantity: 2 },
      { itemId: 'wood', name: '木材', quantity: 1 },
    ])
    expect((await service.getStatus(actor('one'))).character?.actionPoints).toBe(2)
    expect(await service.createCharacter(actor('one'), '另一个角色', 'create-two')).toMatchObject({
      ok: false,
      code: 'active-character-exists',
    })
  })

  it('does not charge invalid or unavailable actions', async () => {
    const { service } = await createService()
    await service.createCharacter(actor('invalid'), '测试者', 'invalid-create')
    expect(await service.executeAction(actor('invalid'), 'unknown', 'invalid-action')).toMatchObject({
      ok: false,
      code: 'invalid-action',
    })
    expect(await service.executeAction(actor('invalid'), 'craft:ration', 'unavailable-action')).toMatchObject({
      ok: false,
      code: 'requirements-not-met',
    })
    expect((await service.getStatus(actor('invalid'))).character).toMatchObject({
      hp: 5,
      actionPoints: 3,
      hungerDays: 0,
    })
    expect((await service.getInventory(actor('invalid'))).items).toEqual([
      { itemId: 'ration', name: '口粮', quantity: 3 },
    ])
  })

  it('collects, crafts, builds, explores, and settles automatic combat', async () => {
    const game = await createService()
    await game.service.createCharacter(actor('builder'), '建造者', 'builder-create')
    await game.service.executeAction(actor('builder'), 'collect', 'builder-collect-1')
    await game.service.executeAction(actor('builder'), 'collect', 'builder-collect-2')
    await game.service.executeAction(actor('builder'), 'collect', 'builder-collect-3')

    game.setNow('2026-07-31T04:00:00.000Z')
    const built = await game.service.executeAction(actor('builder'), 'build:shelter', 'builder-build')
    expect(built.message).toContain('庇护所')
    expect((await game.service.getCamp(actor('builder'))).buildings).toHaveLength(1)

    game.setRandom(0.999)
    await game.service.createCharacter(actor('fighter'), '战士', 'fighter-create')
    await game.service.executeAction(actor('fighter'), 'explore', 'fighter-explore')
    const choices = await game.service.listActions(actor('fighter'))
    expect(choices.map(choice => choice.actionId)).toEqual(['choice:investigate', 'choice:leave'])
    const combat = await game.service.resolveChoice(actor('fighter'), 'investigate', 'fighter-fight')
    expect(combat.code).toBe('combat-won')
    expect((await game.service.getStatus(actor('fighter'))).character?.hp).toBe(4)

    game.setRandom(0)
    await game.service.createCharacter(actor('crafter'), '工匠', 'crafter-create')
    await game.service.executeAction(actor('crafter'), 'collect', 'crafter-collect-1')
    await game.service.executeAction(actor('crafter'), 'collect', 'crafter-collect-2')
    const crafted = await game.service.executeAction(actor('crafter'), 'craft:ration', 'crafter-craft')
    expect(crafted.message).toContain('制作了 1 份口粮')
    expect((await game.service.getInventory(actor('crafter'))).items).toEqual([
      { itemId: 'ration', name: '口粮', quantity: 3 },
    ])
  })

  it('refreshes AP lazily and only starves on active days', async () => {
    const game = await createService()
    await game.service.createCharacter(actor('hungry'), '饥者', 'hungry-create')
    await game.service.executeAction(actor('hungry'), 'collect', 'hungry-day-1')

    game.setNow('2026-07-31T04:00:00.000Z')
    expect((await game.service.getStatus(actor('hungry'))).character?.actionPoints).toBe(3)
    expect((await game.service.getStatus(actor('hungry'))).character?.hp).toBe(5)
    await game.service.executeAction(actor('hungry'), 'collect', 'hungry-day-2')

    game.setNow('2026-08-01T04:00:00.000Z')
    await game.service.executeAction(actor('hungry'), 'collect', 'hungry-day-3')
    for (const [day, date] of [
      ['4', '2026-08-02T04:00:00.000Z'],
      ['5', '2026-08-03T04:00:00.000Z'],
      ['6', '2026-08-04T04:00:00.000Z'],
      ['7', '2026-08-05T04:00:00.000Z'],
    ]) {
      game.setNow(date)
      await game.service.executeAction(actor('hungry'), 'collect', `hungry-day-${day}`)
    }
    game.setNow('2026-08-06T04:00:00.000Z')
    const died = await game.service.executeAction(actor('hungry'), 'collect', 'hungry-day-8')
    expect(died.code).toBe('character-died')
    expect((await game.service.getStatus(actor('hungry'))).character).toBeNull()
    expect((await game.service.getHistory(actor('hungry'))).characters[0].deathCause).toBe('hunger')
  })

  it('persists suicide confirmation, cancellation, and death history', async () => {
    const { service } = await createService()
    await service.createCharacter(actor('choice'), '选择者', 'choice-create')
    await service.requestSuicide(actor('choice'), 'choice-request-1')
    expect((await service.listActions(actor('choice'))).map(option => option.actionId)).toEqual([
      'choice:confirm',
      'choice:cancel',
    ])
    await service.resolveChoiceByIndex(actor('choice'), 2, 'choice-cancel')
    expect((await service.getStatus(actor('choice'))).character).not.toBeNull()

    await service.requestSuicide(actor('choice'), 'choice-request-2')
    await service.resolveChoiceByIndex(actor('choice'), 1, 'choice-confirm')
    const history = await service.getHistory(actor('choice'))
    expect(history.total).toBe(1)
    expect(history.characters[0].deathCause).toBe('suicide')
    expect(await service.createCharacter(actor('choice'), undefined, 'choice-create-2')).toMatchObject({ ok: true })
  })

  it('resolves pending choices by index and lets unrelated numeric input pass through', async () => {
    const { service } = await createService()
    expect(await service.resolveChoiceByIndex(actor('unknown'), 1, 'unknown-number')).toBeNull()

    await service.createCharacter(actor('numeric'), '数字玩家', 'numeric-create')
    expect(await service.resolveChoiceByIndex(actor('numeric'), 1, 'numeric-without-choice')).toBeNull()
    await service.executeAction(actor('numeric'), 'explore', 'numeric-explore')
    expect(await service.resolveChoiceByIndex(actor('numeric'), 4, 'numeric-invalid')).toMatchObject({
      ok: false,
      code: 'invalid-choice',
    })
    expect(await service.resolveChoiceByIndex(actor('numeric'), 2, 'numeric-leave')).toMatchObject({
      ok: true,
      code: 'event-resolved',
    })
  })

  it('filters the night event at Asia/Shanghai time boundaries', async () => {
    const game = await createService(':memory:', 5 * 60 * 1000, 0.65)
    const cases = [
      ['before-night', '2026-07-30T11:59:00.000Z', false],
      ['night-start', '2026-07-30T12:00:00.000Z', true],
      ['before-dawn', '2026-07-30T21:59:00.000Z', true],
      ['night-end', '2026-07-30T22:00:00.000Z', false],
    ] as const

    for (const [userId, now, expectedNight] of cases) {
      game.setNow(now)
      await game.service.createCharacter(actor(userId), userId, `${userId}-create`)
      await game.service.executeAction(actor(userId), 'explore', `${userId}-explore`)
      const characterId = await activeCharacterId(game.ctx, userId)
      const [pending] = await game.ctx.database.get('drift_pending_choice', { characterId })
      expect(pending.sourceId === 'forest-night-glow', userId).toBe(expectedNight)
    }
  })

  it('tracks occurrence variants, cooldowns, and maximum occurrences', async () => {
    const game = await createService()
    await game.service.createCharacter(actor('progress'), '进度玩家', 'progress-create')
    const characterId = await activeCharacterId(game.ctx, 'progress')

    await game.service.executeAction(actor('progress'), 'explore', 'progress-explore-1')
    let [pending] = await game.ctx.database.get('drift_pending_choice', { characterId })
    expect(pending).toMatchObject({ sourceId: 'forest-trapped-animal', variantId: 'first' })
    await game.service.resolveChoice(actor('progress'), 'leave', 'progress-leave-1')

    await game.service.executeAction(actor('progress'), 'explore', 'progress-cooldown-check')
    ;[pending] = await game.ctx.database.get('drift_pending_choice', { characterId })
    expect(pending.sourceId).toBe('forest-strange-fungi')
    await game.service.resolveChoice(actor('progress'), 'leave', 'progress-fungus-leave')

    await game.ctx.database.set('drift_character_event', { characterId, eventId: 'forest-trapped-animal' }, { cooldownUntil: null })
    await game.service.executeAction(actor('progress'), 'explore', 'progress-explore-2')
    ;[pending] = await game.ctx.database.get('drift_pending_choice', { characterId })
    expect(pending).toMatchObject({ sourceId: 'forest-trapped-animal', variantId: 'second' })
    await game.service.resolveChoice(actor('progress'), 'leave', 'progress-leave-2')

    await game.ctx.database.set('drift_character_event', { characterId, eventId: 'forest-trapped-animal' }, { cooldownUntil: null })
    await game.ctx.database.set('drift_character', { id: characterId }, { actionPoints: 1 })
    await game.service.executeAction(actor('progress'), 'explore', 'progress-explore-3')
    ;[pending] = await game.ctx.database.get('drift_pending_choice', { characterId })
    expect(pending).toMatchObject({ sourceId: 'forest-trapped-animal', variantId: 'third' })
    await game.service.resolveChoice(actor('progress'), 'leave', 'progress-leave-3')

    const [progress] = await game.ctx.database.get('drift_character_event', {
      characterId,
      eventId: 'forest-trapped-animal',
    })
    expect(progress).toMatchObject({ occurrenceCount: 3, lastChoiceId: 'leave' })
    expect(progress.choiceCounts.leave).toBe(3)

    await game.ctx.database.set('drift_character', { id: characterId }, { actionPoints: 1 })
    await game.service.executeAction(actor('progress'), 'explore', 'progress-after-max')
    ;[pending] = await game.ctx.database.get('drift_pending_choice', { characterId })
    expect(pending.sourceId).not.toBe('forest-trapped-animal')
  })

  it('uses event private state when selecting a variant', async () => {
    const game = await createService()
    await game.service.createCharacter(actor('state-read'), '状态读取者', 'state-read-create')
    const characterId = await activeCharacterId(game.ctx, 'state-read')
    await game.ctx.database.create('drift_character_event', {
      characterId,
      eventId: 'forest-trapped-animal',
      occurrenceCount: 0,
      lastTriggeredAt: null,
      cooldownUntil: null,
      lastChoiceId: null,
      choiceCounts: {},
      state: { seen: true },
      createdAt: new Date('2026-07-30T04:00:00.000Z'),
      updatedAt: new Date('2026-07-30T04:00:00.000Z'),
    })
    const content = (game.service as unknown as { content: ContentStore }).content
    content.event('forest-trapped-animal').variants[0].conditions = [{
      type: 'eventState',
      key: 'seen',
      operator: 'eq',
      value: true,
    }]
    await game.service.executeAction(actor('state-read'), 'explore', 'state-read-explore')
    const [pending] = await game.ctx.database.get('drift_pending_choice', { characterId })
    expect(pending.variantId).toBe('first')
  })

  it('shows unavailable choices and uses a crafted tool without consuming it', async () => {
    const blocked = await createService(':memory:', 5 * 60 * 1000, 0.65)
    await blocked.service.createCharacter(actor('blocked-tool'), '徒手者', 'blocked-create')
    await blocked.service.executeAction(actor('blocked-tool'), 'explore', 'blocked-explore')
    const blockedActions = await blocked.service.listActions(actor('blocked-tool'))
    expect(blockedActions.find(action => action.actionId === 'choice:cut-trunk')).toMatchObject({
      enabled: false,
      disabledReason: '需要能够切割木材的工具',
    })
    expect(await blocked.service.resolveChoice(actor('blocked-tool'), 'cut-trunk', 'blocked-cut')).toMatchObject({
      ok: false,
      code: 'requirements-not-met',
    })
    expect((await blocked.service.getStatus(actor('blocked-tool'))).pendingTitle).toBe('倒下的巨树')

    const game = await createService()
    await game.service.createCharacter(actor('tool'), '工具玩家', 'tool-create')
    await game.service.executeAction(actor('tool'), 'collect', 'tool-wood-1')
    await game.service.executeAction(actor('tool'), 'collect', 'tool-wood-2')
    game.setRandom(0.999)
    await game.service.executeAction(actor('tool'), 'collect', 'tool-stone')
    game.setNow('2026-07-31T04:00:00.000Z')
    expect(game.service.findCraftableItem('石斧')).toBe('stone-axe')
    await game.service.executeAction(actor('tool'), 'craft:stone-axe', 'tool-craft')
    game.setRandom(0.65)
    await game.service.executeAction(actor('tool'), 'explore', 'tool-explore')
    const options = await game.service.listActions(actor('tool'))
    expect(options.find(action => action.actionId === 'choice:cut-trunk')?.enabled).toBe(true)
    await game.ctx.database.remove('drift_inventory', { characterId: await activeCharacterId(game.ctx, 'tool'), itemId: 'stone-axe' })
    expect(await game.service.resolveChoice(actor('tool'), 'cut-trunk', 'tool-cut-missing')).toMatchObject({
      ok: false,
      code: 'requirements-not-met',
    })
    await game.ctx.database.create('drift_inventory', {
      characterId: await activeCharacterId(game.ctx, 'tool'),
      itemId: 'stone-axe',
      quantity: 1,
      updatedAt: new Date('2026-07-31T04:00:00.000Z'),
    })
    await game.service.resolveChoice(actor('tool'), 'cut-trunk', 'tool-cut')
    expect((await game.service.getInventory(actor('tool'))).items).toEqual(expect.arrayContaining([
      { itemId: 'stone-axe', name: '石斧', quantity: 1 },
      { itemId: 'wood', name: '木材', quantity: 6 },
    ]))
  })

  it('expires new and legacy pending choices after the configured timeout', async () => {
    const game = await createService(':memory:', 3 * 60 * 1000)
    await game.service.createCharacter(actor('timeout'), '迟到者', 'timeout-create')
    await game.service.executeAction(actor('timeout'), 'explore', 'timeout-explore')
    const before = await game.service.getStatus(actor('timeout'))
    expect(before.pendingExpiresAt?.toISOString()).toBe('2026-07-30T04:03:00.000Z')

    const [identity] = await game.ctx.database.get('drift_identity', {
      platform: 'test',
      platformUserId: 'timeout',
    })
    const [user] = await game.ctx.database.get('drift_user', { id: identity.userId })
    const [pending] = await game.ctx.database.get('drift_pending_choice', { characterId: user.activeCharacterId! })
    const legacyOptions = pending.options.map(option => ({ id: option.id, label: option.label, outcome: option.outcome }))
    await game.ctx.database.set('drift_pending_choice', { characterId: user.activeCharacterId! }, {
      defaultOptionId: null,
      variantId: null,
      options: legacyOptions,
      expiresAt: null,
    })
    game.setNow('2026-07-30T04:03:01.000Z')

    const resolved = await game.service.settleExpiredChoice(actor('timeout'), 'timeout-choice')
    expect(resolved).toMatchObject({
      ok: true,
      code: 'choice-timeout',
    })
    expect(resolved?.message).toContain('自动选择“安全离开”')
    expect(await game.service.settleExpiredChoice(actor('timeout'), 'timeout-choice')).toEqual(resolved)
    expect((await game.service.getStatus(actor('timeout'))).pendingTitle).toBeUndefined()
    expect(await game.service.resolveChoiceByIndex(actor('timeout'), 1, 'timeout-no-choice')).toBeNull()
  })

  it('applies event effects atomically, records private state, and supports event death', async () => {
    const { ctx, service } = await createService()
    await service.createCharacter(actor('effects'), '效果玩家', 'effects-create')
    const characterId = await activeCharacterId(ctx, 'effects')
    const now = new Date('2026-07-30T04:00:00.000Z')
    await ctx.database.create('drift_pending_choice', {
      characterId,
      kind: 'event',
      sourceId: 'forest-trapped-animal',
      sourceVersion: 1,
      variantId: 'test',
      defaultOptionId: 'leave',
      options: [
        {
          id: 'costly',
          label: '支付两份口粮',
          enabled: true,
          default: false,
          outcome: {
            type: 'effects',
            effects: [
              { type: 'gainItem', itemId: 'wood', quantity: 5 },
              { type: 'consumeItem', itemId: 'ration', quantity: 4 },
            ],
            message: '交换成功。',
          },
        },
        { id: 'leave', label: '离开', enabled: true, default: true, outcome: { type: 'nothing', message: '离开了。' } },
      ],
      createdAt: now,
      expiresAt: new Date(now.getTime() + 300_000),
    })

    expect(await service.resolveChoice(actor('effects'), 'costly', 'effects-costly')).toMatchObject({
      ok: false,
      code: 'requirements-not-met',
    })
    expect((await service.getInventory(actor('effects'))).items).toEqual([
      { itemId: 'ration', name: '口粮', quantity: 3 },
    ])
    expect((await service.getStatus(actor('effects'))).pendingTitle).toBeTruthy()

    await ctx.database.set('drift_pending_choice', { characterId }, {
      defaultOptionId: 'state',
      options: [{
        id: 'state',
        label: '记录状态',
        enabled: true,
        default: true,
        outcome: {
          type: 'effects',
          effects: [
            { type: 'setState', key: 'met', value: true },
            { type: 'incrementState', key: 'visits', amount: 1 },
            { type: 'adjustHp', amount: -1 },
          ],
          message: '状态已记录。',
        },
      }],
    })
    await service.resolveChoice(actor('effects'), 'state', 'effects-state')
    const [progress] = await ctx.database.get('drift_character_event', { characterId, eventId: 'forest-trapped-animal' })
    expect(progress.state).toEqual({ met: true, visits: 1 })
    expect(progress.choiceCounts.state).toBe(1)
    expect((await service.getStatus(actor('effects'))).character?.hp).toBe(4)

    await ctx.database.create('drift_pending_choice', {
      characterId,
      kind: 'event',
      sourceId: 'forest-strange-fungi',
      sourceVersion: 1,
      variantId: 'fatal',
      defaultOptionId: 'fatal',
      options: [{
        id: 'fatal',
        label: '承受伤害',
        enabled: true,
        default: true,
        outcome: {
          type: 'effects',
          effects: [{ type: 'adjustHp', amount: -5 }],
          message: '你受到了致命伤。',
        },
      }],
      createdAt: now,
      expiresAt: new Date(now.getTime() + 300_000),
    })
    expect(await service.resolveChoice(actor('effects'), 'fatal', 'effects-fatal')).toMatchObject({
      ok: true,
      code: 'character-died',
    })
    expect((await service.getHistory(actor('effects'))).characters[0].deathCause).toBe('event')
  })

  it('uses the exploration fallback when every event is unavailable', async () => {
    const game = await createService()
    await game.service.createCharacter(actor('fallback'), '保底玩家', 'fallback-create')
    const characterId = await activeCharacterId(game.ctx, 'fallback')
    const now = new Date('2026-07-30T04:00:00.000Z')
    const future = new Date('2099-01-01T00:00:00.000Z')
    for (const eventId of [
      'forest-trapped-animal',
      'forest-strange-fungi',
      'forest-fallen-tree',
      'forest-night-glow',
      'forest-tree-hole-creature',
      'forest-rustle',
    ]) {
      await game.ctx.database.create('drift_character_event', {
        characterId,
        eventId,
        occurrenceCount: eventId === 'forest-trapped-animal' || eventId === 'forest-fallen-tree' || eventId === 'forest-tree-hole-creature' ? 3 : 1,
        lastTriggeredAt: now,
        cooldownUntil: future,
        lastChoiceId: null,
        choiceCounts: {},
        state: {},
        createdAt: now,
        updatedAt: now,
      })
    }
    const result = await game.service.executeAction(actor('fallback'), 'explore', 'fallback-explore')
    expect(result.message).toContain('只找到 1 份木材')
    expect((await game.service.getInventory(actor('fallback'))).items).toContainEqual({
      itemId: 'wood',
      name: '木材',
      quantity: 1,
    })
  })

  it('records combat death without granting rewards', async () => {
    const { ctx, service } = await createService(':memory:', 5 * 60 * 1000, 0.999)
    await service.createCharacter(actor('doomed'), '伤员', 'doomed-create')
    await service.executeAction(actor('doomed'), 'explore', 'doomed-explore')
    const [identity] = await ctx.database.get('drift_identity', { platform: 'test', platformUserId: 'doomed' })
    const [user] = await ctx.database.get('drift_user', { id: identity.userId })
    await ctx.database.set('drift_character', { id: user.activeCharacterId! }, { hp: 1 })

    const result = await service.resolveChoice(actor('doomed'), 'investigate', 'doomed-fight')
    expect(result.code).toBe('character-died')
    expect((await service.getHistory(actor('doomed'))).characters[0].deathCause).toBe('combat')
    const inventory = await ctx.database.get('drift_inventory', { characterId: user.activeCharacterId! })
    expect(inventory).toMatchObject([{ itemId: 'ration', quantity: 2 }])
  })

  it('does not overwrite existing seed rows on a later startup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'drift-test-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'drift.db')
    const first = await createService(databasePath)
    const [forest] = await first.ctx.database.get('drift_content', { type: 'region', contentId: 'forest' })
    await first.ctx.database.set('drift_content', { id: forest.id }, {
      data: { ...forest.data, name: '自定义森林' },
    })
    await first.ctx.stop()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await createService(databasePath)
    const [preserved] = await second.ctx.database.get('drift_content', { type: 'region', contentId: 'forest' })
    expect(preserved.data.name).toBe('自定义森林')
    expect(await second.ctx.database.get('drift_content', {})).toHaveLength(15)
  })

  it('applies a seed update only when its version increases', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'drift-test-'))
    temporaryDirectories.push(directory)
    const databasePath = join(directory, 'drift.db')
    const first = await createService(databasePath)
    const [wood] = await first.ctx.database.get('drift_content', { type: 'item', contentId: 'wood' })
    await first.ctx.database.set('drift_content', { id: wood.id }, {
      version: 0,
      data: { name: '旧木材', description: '旧配置', kind: 'resource' },
    })
    await first.ctx.stop()
    contexts.splice(contexts.indexOf(first.ctx), 1)

    const second = await createService(databasePath)
    const [updated] = await second.ctx.database.get('drift_content', { type: 'item', contentId: 'wood' })
    expect(updated.version).toBe(1)
    expect(updated.data).toMatchObject({ name: '木材', description: '可以用于制作和建造的普通木材。' })
    await second.ctx.stop()
  })

  it('supports idempotent developer state controls', async () => {
    const game = await createService()
    await game.service.createCharacter(actor('developer'), '测试角色', 'developer-create')
    const characterId = await activeCharacterId(game.ctx, 'developer')

    await game.service.debugGiveItem(actor('developer'), '木材', 5, 'developer-give')
    await game.service.debugSetStat(actor('developer'), 'hp', 1, 'developer-hp')
    await game.service.debugSetStat(actor('developer'), 'ap', 0, 'developer-ap')
    const triggered = await game.service.debugTriggerEvent(
      actor('developer'),
      'forest-fallen-tree',
      'third',
      'developer-event',
    )
    expect(triggered.message).toContain('巨树只剩下')
    expect(await game.service.debugTriggerEvent(
      actor('developer'),
      'forest-trapped-animal',
      undefined,
      'developer-event-while-pending',
    )).toMatchObject({ ok: false, code: 'pending-choice' })

    await game.service.debugClearEvents(actor('developer'), 'forest-fallen-tree', 'developer-clear')
    expect(await game.ctx.database.get('drift_pending_choice', { characterId })).toHaveLength(0)
    expect(await game.ctx.database.get('drift_character_event', { characterId })).toHaveLength(0)

    const firstReset = await game.service.resetCharacter(actor('developer'), 'developer-reset')
    const repeatedReset = await game.service.resetCharacter(actor('developer'), 'developer-reset')
    expect(repeatedReset).toEqual(firstReset)
    expect((await game.service.getStatus(actor('developer'))).character).toMatchObject({
      id: characterId,
      hp: 5,
      maxHp: 5,
      actionPoints: 3,
      maxActionPoints: 3,
      regionId: 'forest',
      hungerDays: 0,
    })
    expect((await game.service.getInventory(actor('developer'))).items).toEqual([
      { itemId: 'ration', name: '口粮', quantity: 3 },
    ])
    expect(await game.ctx.database.get('drift_action_log', { characterId })).not.toHaveLength(0)
  })

  it('checks, hot-loads, syncs, and exports external JSON content', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'drift-content-test-'))
    temporaryDirectories.push(directory)
    const contentDir = join(directory, 'content')
    const itemDir = join(contentDir, 'items')
    await mkdir(itemDir, { recursive: true })
    const game = await createService(':memory:', 5 * 60 * 1000, 0, contentDir)
    await game.service.createCharacter(actor('content-dev'), '内容测试者', 'content-dev-create')
    const [wood] = await game.ctx.database.get('drift_content', { type: 'item', contentId: 'wood' })
    const overridePath = join(itemDir, 'wood.json')
    const override = {
      type: 'item',
      contentId: 'wood',
      version: 2,
      data: { ...wood.data, name: '测试木材' },
    }
    await writeFile(overridePath, `${JSON.stringify(override, null, 2)}\n`)

    expect(await game.service.checkContent()).toMatchObject({ ok: true, externalCount: 1, totalCount: 15 })
    expect(await game.service.loadContent()).toMatchObject({ ok: true, code: 'content-loaded' })
    expect(await game.service.debugGiveItem(actor('content-dev'), '测试木材', 1, 'content-dev-give')).toMatchObject({ ok: true })

    await writeFile(overridePath, `${JSON.stringify({
      ...override,
      data: { ...override.data, recipe: { apCost: 1, ingredients: [{ itemId: 'missing', quantity: 1 }], outputQuantity: 1 } },
    }, null, 2)}\n`)
    expect(await game.service.loadContent()).toMatchObject({ ok: false, code: 'content-load-failed' })
    expect(await game.service.debugGiveItem(actor('content-dev'), '测试木材', 1, 'content-dev-give-after-failure')).toMatchObject({ ok: true })

    await writeFile(overridePath, `${JSON.stringify(override, null, 2)}\n`)
    expect(await game.service.syncContent()).toMatchObject({ ok: true, updated: 1 })
    const [published] = await game.ctx.database.get('drift_content', { type: 'item', contentId: 'wood' })
    expect(published).toMatchObject({ version: 2, data: expect.objectContaining({ name: '测试木材' }) })

    await writeFile(overridePath, `${JSON.stringify({
      ...override,
      data: { ...override.data, description: '同版本冲突' },
    }, null, 2)}\n`)
    expect(await game.service.syncContent()).toMatchObject({ ok: false, code: 'content-sync-failed' })
    const exportResult = await game.service.exportContent('item', 'ration', false)
    expect(exportResult).toMatchObject({ ok: true, code: 'content-exported' })
    const exported = JSON.parse(await readFile(exportResult.path!, 'utf8'))
    expect(exported).toMatchObject({ type: 'item', contentId: 'ration', version: 2 })
    expect(await game.service.exportContent('item', 'ration', false)).toMatchObject({ ok: false })
  })
})
