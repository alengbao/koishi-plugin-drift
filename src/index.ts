import { Context, Schema, Time } from 'koishi'
import { resolve } from 'node:path'
import { registerCommands } from './adapter/commands'
import { DriftService } from './core/service'
import { defineModels } from './storage/schema'

export * from './core/service'
export * from './core/types'
export * from './content/schema'
export * from './storage/schema'

export const name = 'drift'
export const inject = ['database']

export interface Config {
  choiceTimeout: number
  testMode: boolean
  contentDir: string
}

export const Config: Schema<Config> = Schema.object({
  choiceTimeout: Schema.natural()
    .role('ms')
    .min(Time.minute)
    .max(Time.minute * 30)
    .default(Time.minute * 5)
    .description('事件和确认选项等待玩家输入数字的时间。'),
  testMode: Schema.boolean()
    .default(false)
    .description('启用仅供沙盒或高权限用户使用的 Drift 测试命令。'),
  contentDir: Schema.string()
    .default('data/drift/content')
    .description('外部 JSON 内容目录，相对于 Koishi 工作目录。'),
})

export function apply(ctx: Context, config: Config = {
  choiceTimeout: Time.minute * 5,
  testMode: false,
  contentDir: 'data/drift/content',
}) {
  defineModels(ctx)
  const contentDir = resolve(ctx.baseDir, config.contentDir)
  const drift = new DriftService(ctx, { choiceTimeout: config.choiceTimeout, contentDir })
  registerCommands(ctx, drift, { testMode: config.testMode, contentDir })
}
