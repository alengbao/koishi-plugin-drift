import { Context, Schema, Time } from 'koishi'
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
}

export const Config: Schema<Config> = Schema.object({
  choiceTimeout: Schema.natural()
    .role('ms')
    .min(Time.minute)
    .max(Time.minute * 30)
    .default(Time.minute * 5)
    .description('事件和确认选项等待玩家输入数字的时间。'),
})

export function apply(ctx: Context, config: Config = { choiceTimeout: Time.minute * 5 }) {
  defineModels(ctx)
  const drift = new DriftService(ctx, { choiceTimeout: config.choiceTimeout })
  registerCommands(ctx, drift)
}
