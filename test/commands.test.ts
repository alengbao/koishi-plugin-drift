import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'koishi'
import SQLite from '@koishijs/plugin-database-sqlite'
import { apply } from '../src'
import { renderInventory } from '../src/adapter/commands'

describe('command registration', () => {
  let ctx: Context | undefined

  afterEach(async () => ctx?.stop())

  it('registers English commands and Chinese aliases', () => {
    ctx = new Context()
    ctx.plugin(SQLite, { path: ':memory:' })
    apply(ctx)

    for (const name of [
      'drift',
      'drift.create',
      'drift.status',
      'drift.actions',
      'drift.collect',
      'drift.explore',
      'drift.craft',
      'drift.build',
      'drift.inventory',
      'drift.camp',
      'drift.history',
      'drift.suicide',
      '漂流',
      '漂流.创建',
      '漂流.状态',
      '漂流.行动',
      '漂流.收集',
      '漂流.探索',
      '漂流.制作',
      '漂流.建造',
      '漂流.背包',
      '漂流.营地',
      '漂流.历史',
      '漂流.自尽',
    ]) {
      expect(ctx.$commander.get(name), name).toBeTruthy()
    }
    expect(ctx.$commander.get('drift.dev')).toBeFalsy()
  })

  it('only registers the short developer commands in test mode', () => {
    ctx = new Context()
    ctx.plugin(SQLite, { path: ':memory:' })
    apply(ctx, {
      choiceTimeout: 5 * 60 * 1000,
      testMode: true,
      contentDir: 'data/drift/content',
    })
    for (const name of [
      'drift.dev',
      'drift.dev.reset',
      'drift.dev.give',
      'drift.dev.hp',
      'drift.dev.ap',
      'drift.dev.clear',
      'drift.dev.event',
      'drift.dev.check',
      'drift.dev.load',
      'drift.dev.sync',
      'drift.dev.export',
    ]) {
      expect(ctx.$commander.get(name), name).toBeTruthy()
    }
  })

  it('renders food batches, permanent food, and spoilage', () => {
    expect(renderInventory({
      characterId: 1,
      spoiled: [{ itemId: 'fresh-fish', name: '鲜鱼', quantity: 1 }],
      items: [
        { itemId: 'ration', name: '口粮', quantity: 3, acquiredOn: '2026-08-01', expiresOn: null },
        { itemId: 'fresh-fish', name: '鲜鱼', quantity: 2, acquiredOn: '2026-08-01', expiresOn: '2026-08-03' },
        { itemId: 'wood', name: '木材', quantity: 4 },
      ],
    })).toBe([
      '已丢弃腐坏食物：鲜鱼 x1。',
      '背包：',
      '- 口粮 x 3（长期保存）',
      '- 鲜鱼 x 2（2026-08-03 腐坏）',
      '- 木材 x 4',
    ].join('\n'))
  })
})
