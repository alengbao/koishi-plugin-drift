import { afterEach, describe, expect, it } from 'vitest'
import { Context } from 'koishi'
import SQLite from '@koishijs/plugin-database-sqlite'
import { apply } from '../src'

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
  })
})
