import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'koishi'
import SQLite from '@koishijs/plugin-database-sqlite'
import { DriftService } from '../src/core/service'
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

  async function createService(path = ':memory:', choiceTimeout = 5 * 60 * 1000) {
    let current = new Date('2026-07-30T04:00:00.000Z')
    const ctx = new Context()
    contexts.push(ctx)
    ctx.plugin(SQLite, { path })
    let service!: DriftService
    ctx.plugin({
      name: 'drift-test',
      inject: ['database'],
      apply(pluginContext: Context) {
        defineModels(pluginContext)
        service = new DriftService(pluginContext, { now: () => current, random: () => 0, choiceTimeout })
      },
    })
    await ctx.start()
    return {
      ctx,
      service,
      setNow(value: string) { current = new Date(value) },
    }
  }

  it('creates all eight tables and seeds content', async () => {
    const { ctx } = await createService()
    const tableNames = Object.keys(ctx.model.tables).filter(name => name.startsWith('drift_'))
    expect(tableNames).toHaveLength(8)
    expect(await ctx.database.get('drift_content', {})).toHaveLength(6)
  })

  it('creates a default character and makes repeated writes idempotent', async () => {
    const { service } = await createService()
    const created = await service.createCharacter(actor('one'), undefined, 'create-one')
    expect(created.message).toContain('“流浪者”')

    const first = await service.executeAction(actor('one'), 'collect', 'collect-one')
    const repeated = await service.executeAction(actor('one'), 'collect', 'collect-one')
    expect(repeated).toEqual(first)

    const inventory = await service.getInventory(actor('one'))
    expect(inventory.items).toEqual([{ itemId: 'wood', name: '木材', quantity: 1 }])
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
      hp: 3,
      actionPoints: 3,
      hungerDays: 0,
    })
    expect((await service.getInventory(actor('invalid'))).items).toEqual([
      { itemId: 'ration', name: '口粮', quantity: 1 },
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

    await game.service.createCharacter(actor('fighter'), '战士', 'fighter-create')
    await game.service.executeAction(actor('fighter'), 'explore', 'fighter-explore')
    const choices = await game.service.listActions(actor('fighter'))
    expect(choices.map(choice => choice.actionId)).toEqual(['choice:investigate', 'choice:leave'])
    const combat = await game.service.resolveChoice(actor('fighter'), 'investigate', 'fighter-fight')
    expect(combat.code).toBe('combat-won')
    expect((await game.service.getStatus(actor('fighter'))).character?.hp).toBe(2)

    await game.service.createCharacter(actor('crafter'), '工匠', 'crafter-create')
    await game.service.executeAction(actor('crafter'), 'collect', 'crafter-collect-1')
    await game.service.executeAction(actor('crafter'), 'collect', 'crafter-collect-2')
    const crafted = await game.service.executeAction(actor('crafter'), 'craft:ration', 'crafter-craft')
    expect(crafted.message).toContain('制作了 1 份口粮')
    expect((await game.service.getInventory(actor('crafter'))).items).toEqual([
      { itemId: 'ration', name: '口粮', quantity: 1 },
    ])
  })

  it('refreshes AP lazily and only starves on active days', async () => {
    const game = await createService()
    await game.service.createCharacter(actor('hungry'), '饥者', 'hungry-create')
    await game.service.executeAction(actor('hungry'), 'collect', 'hungry-day-1')

    game.setNow('2026-07-31T04:00:00.000Z')
    expect((await game.service.getStatus(actor('hungry'))).character?.actionPoints).toBe(3)
    expect((await game.service.getStatus(actor('hungry'))).character?.hp).toBe(3)
    await game.service.executeAction(actor('hungry'), 'collect', 'hungry-day-2')

    game.setNow('2026-08-01T04:00:00.000Z')
    await game.service.executeAction(actor('hungry'), 'collect', 'hungry-day-3')
    game.setNow('2026-08-02T04:00:00.000Z')
    const died = await game.service.executeAction(actor('hungry'), 'collect', 'hungry-day-4')
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
    expect(await service.resolveChoiceByIndex(actor('numeric'), 3, 'numeric-invalid')).toMatchObject({
      ok: false,
      code: 'invalid-choice',
    })
    expect(await service.resolveChoiceByIndex(actor('numeric'), 2, 'numeric-leave')).toMatchObject({
      ok: true,
      code: 'event-resolved',
    })
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
    await game.ctx.database.set('drift_pending_choice', { characterId: user.activeCharacterId! }, { expiresAt: null })
    game.setNow('2026-07-30T04:03:01.000Z')

    expect(await game.service.resolveChoiceByIndex(actor('timeout'), 1, 'timeout-choice')).toMatchObject({
      ok: false,
      code: 'choice-expired',
    })
    expect((await game.service.getStatus(actor('timeout'))).pendingTitle).toBeUndefined()
    expect(await game.service.resolveChoiceByIndex(actor('timeout'), 1, 'timeout-no-choice')).toBeNull()
  })

  it('records combat death without granting rewards', async () => {
    const { ctx, service } = await createService()
    await service.createCharacter(actor('doomed'), '伤员', 'doomed-create')
    await service.executeAction(actor('doomed'), 'explore', 'doomed-explore')
    const [identity] = await ctx.database.get('drift_identity', { platform: 'test', platformUserId: 'doomed' })
    const [user] = await ctx.database.get('drift_user', { id: identity.userId })
    await ctx.database.set('drift_character', { id: user.activeCharacterId! }, { hp: 1 })

    const result = await service.resolveChoice(actor('doomed'), 'investigate', 'doomed-fight')
    expect(result.code).toBe('character-died')
    expect((await service.getHistory(actor('doomed'))).characters[0].deathCause).toBe('combat')
    const inventory = await ctx.database.get('drift_inventory', { characterId: user.activeCharacterId! })
    expect(inventory).toHaveLength(0)
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
    expect(await second.ctx.database.get('drift_content', {})).toHaveLength(6)
  })
})
