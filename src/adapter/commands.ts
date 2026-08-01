import { randomUUID } from 'node:crypto'
import type { Command, Context, Session } from 'koishi'
import {
  contentTypes,
  type ActorIdentity,
  type CampView,
  type CharacterHistory,
  type ContentReport,
  type ContentType,
  type GameSnapshot,
  type InventoryView,
} from '../core/types'
import type { DriftService } from '../core/service'

function actorFrom(session: Session): ActorIdentity {
  return {
    platform: session.platform,
    platformUserId: session.userId!,
  }
}

function requestId(session: Session, action: string) {
  const messageId = session.messageId || randomUUID()
  return [session.platform, session.selfId, session.channelId, messageId, action].join(':')
}

function renderStatus(snapshot: GameSnapshot) {
  const character = snapshot.character
  if (!character) return '你还没有存活角色。使用 drift.create [名字] 创建角色。'
  const lines = [
    `${character.name} #${character.id}`,
    `地区：${character.regionId === 'forest' ? '森林' : character.regionId}`,
    `生命：${character.hp}/${character.maxHp}`,
    `行动点：${character.actionPoints}/${character.maxActionPoints}`,
    `饥饿行动日：${character.hungerDays}`,
  ]
  if (snapshot.pendingTitle) {
    lines.push(`待处理：${snapshot.pendingTitle}`)
    if (snapshot.pendingExpiresAt) {
      lines.push(`选择截止：${snapshot.pendingExpiresAt.toLocaleTimeString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
      })}`)
    }
    lines.push('请直接发送选项数字。')
  }
  return lines.join('\n')
}

const usageText = [
  '事件或确认出现后，请在有效时间内直接发送 1、2 等数字。',
  '使用 drift actions 查看当前可执行的行动。',
].join('\n')

const actionCommands: Record<string, string> = {
  collect: 'drift collect',
  explore: 'drift explore',
  'build:shelter': 'drift build shelter',
}

function actionCommand(actionId: string) {
  if (actionId.startsWith('craft:')) return `drift craft ${actionId.slice('craft:'.length)}`
  return actionCommands[actionId] ?? actionId
}

export function renderInventory(view: InventoryView) {
  if (!view.characterId) return '你还没有存活角色。'
  const spoiled = view.spoiled.length
    ? `已丢弃腐坏食物：${view.spoiled.map(item => `${item.name} x${item.quantity}`).join('、')}。`
    : ''
  const items = view.items.length
    ? ['背包：', ...view.items.map(item => {
      const expiry = item.expiresOn === undefined
        ? ''
        : item.expiresOn === null
          ? '（长期保存）'
          : `（${item.expiresOn} 腐坏）`
      return `- ${item.name} x ${item.quantity}${expiry}`
    })].join('\n')
    : '背包是空的。'
  return [spoiled, items].filter(Boolean).join('\n')
}

function renderCamp(view: CampView) {
  if (!view.characterId) return '你还没有存活角色。'
  if (!view.buildings.length) return '你还没有建造任何建筑。'
  return ['营地：', ...view.buildings.map(item => `- ${item.name} Lv.${item.level}（${item.regionId}）`)].join('\n')
}

const deathCauseNames = {
  combat: '战斗',
  hunger: '饥饿',
  suicide: '自尽',
  event: '探索事件',
} as const

function renderHistory(history: CharacterHistory) {
  if (!history.total) return '还没有死亡角色。'
  const entries = history.characters.map(character => {
    const time = character.diedAt.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })
    return `- ${character.name} #${character.id}：${deathCauseNames[character.deathCause]}（${time}）`
  })
  return [`死亡角色：${history.total} 名（显示最近 ${entries.length} 名）`, ...entries].join('\n')
}

function alias(command: Command, name: string) {
  command.alias(name)
  return command
}

function renderContentReport(report: ContentReport) {
  if (!report.ok) return `内容操作失败：${report.message}`
  const details = [
    report.mode ? `来源：${report.mode === 'source' ? 'JSON 源码' : '内置 bundle'}` : '',
    report.totalCount !== undefined ? `内容：${report.totalCount}` : '',
    report.externalCount !== undefined ? `外部覆盖：${report.externalCount}` : '',
    report.inserted !== undefined ? `新增：${report.inserted}` : '',
    report.updated !== undefined ? `更新：${report.updated}` : '',
    report.skipped !== undefined ? `跳过：${report.skipped}` : '',
  ].filter(Boolean)
  return [report.message, details.join('，')].filter(Boolean).join('\n')
}

function canUseDev(session: Session<'authority'>) {
  return session.platform.startsWith('sandbox:') || (session.user?.authority ?? 0) >= 4
}

function devDenied(session: Session<'authority'>) {
  return canUseDev(session) ? undefined : '测试命令仅允许沙盒用户或权限等级至少为 4 的用户使用。'
}

export interface CommandOptions {
  testMode: boolean
  contentDir: string
}

export function registerCommands(ctx: Context, drift: DriftService, options: CommandOptions = {
  testMode: false,
  contentDir: 'data/drift/content',
}) {
  ctx.middleware(async (session, next) => {
    if (!session.userId) return next()
    const actor = actorFrom(session)
    const timeout = await drift.settleExpiredChoice(actor, requestId(session, 'choice-timeout'))
    if (timeout) return timeout.message
    const content = session.content?.trim() ?? ''
    if (!/^[1-9]\d*$/.test(content)) return next()
    const result = await drift.resolveChoiceByIndex(
      actor,
      Number(content),
      requestId(session, `choice-index:${content}`),
    )
    if (!result) return next()
    return result.message
  }, true)

  alias(ctx.command('drift', '漂流生存游戏').usage(usageText), '漂流')
    .action(async ({ session }) => {
      const status = renderStatus(await drift.getStatus(actorFrom(session!)))
      return `${status}\n使用 help drift 或 drift -h 查看命令帮助。`
    })

  alias(ctx.command('drift.create [name:text]', '创建角色'), '漂流.创建')
    .action(async ({ session }, name) => {
      const result = await drift.createCharacter(actorFrom(session!), name, requestId(session!, 'create'))
      return result.message
    })

  alias(ctx.command('drift.status', '查看角色状态'), '漂流.状态')
    .action(async ({ session }) => renderStatus(await drift.getStatus(actorFrom(session!))))

  alias(ctx.command('drift.actions', '查看可用行动'), '漂流.行动')
    .action(async ({ session }) => {
      const actions = await drift.listActions(actorFrom(session!))
      if (!actions.length) return '你还没有存活角色。使用 drift.create [名字] 创建角色。'
      if (actions[0].actionId.startsWith('choice:')) {
        return [
          ...actions.map(action => {
            const disabled = action.enabled ? '' : `（不可用：${action.disabledReason}）`
            return `${action.index}. ${action.label}${disabled}`
          }),
          '请直接发送数字选择。',
        ].join('\n')
      }
      return actions.map(action => {
        const command = actionCommand(action.actionId)
        const cost = action.apCost ? `（${action.apCost} AP）` : ''
        const disabled = action.enabled ? '' : `（不可用：${action.disabledReason}）`
        return `${command} - ${action.label}${cost}${disabled}`
      }).join('\n')
    })

  alias(ctx.command('drift.collect', '收集当前地区的资源'), '漂流.收集')
    .action(async ({ session }) => {
      const result = await drift.executeAction(actorFrom(session!), 'collect', requestId(session!, 'collect'))
      return result.message
    })

  alias(ctx.command('drift.explore', '探索当前地区'), '漂流.探索')
    .action(async ({ session }) => {
      const result = await drift.executeAction(actorFrom(session!), 'explore', requestId(session!, 'explore'))
      return result.message
    })

  alias(ctx.command('drift.craft [item:string]', '制作物品'), '漂流.制作')
    .action(async ({ session }, item) => {
      const itemId = drift.findCraftableItem(item)
      if (!itemId) {
        const available = drift.craftableItems().map(([id, data]) => `${id}（${data.name}）`).join('、')
        return `没有这个制作配方。可制作：${available}`
      }
      const result = await drift.executeAction(actorFrom(session!), `craft:${itemId}`, requestId(session!, `craft:${itemId}`))
      return result.message
    })

  alias(ctx.command('drift.build [building:string]', '建造建筑'), '漂流.建造')
    .action(async ({ session }, building) => {
      const normalized = building?.trim().toLowerCase()
      if (normalized && normalized !== 'shelter' && normalized !== '庇护所') {
        return '第一版只能建造庇护所。使用 drift build shelter。'
      }
      const result = await drift.executeAction(actorFrom(session!), 'build:shelter', requestId(session!, 'build:shelter'))
      return result.message
    })

  alias(ctx.command('drift.inventory', '查看背包'), '漂流.背包')
    .action(async ({ session }) => renderInventory(await drift.getInventory(actorFrom(session!))))

  alias(ctx.command('drift.camp', '查看营地'), '漂流.营地')
    .action(async ({ session }) => renderCamp(await drift.getCamp(actorFrom(session!))))

  alias(ctx.command('drift.history', '查看死亡角色历史'), '漂流.历史')
    .action(async ({ session }) => renderHistory(await drift.getHistory(actorFrom(session!))))

  alias(ctx.command('drift.suicide', '请求结束当前角色'), '漂流.自尽')
    .action(async ({ session }) => {
      const result = await drift.requestSuicide(actorFrom(session!), requestId(session!, 'suicide'))
      return result.message
    })

  if (!options.testMode) return

  const devUsage = [
    `外部内容目录：${options.contentDir}`,
    '状态：reset、give、hp、ap、clear、event',
    '内容：check、load、sync、export',
  ].join('\n')

  ctx.command('drift.dev', 'Drift 测试工具')
    .userFields(['authority'])
    .usage(devUsage)
    .action(({ session }) => devDenied(session!) ?? devUsage)

  ctx.command('drift.dev.reset', '重置当前角色')
    .userFields(['authority'])
    .action(async ({ session }) => {
      const denied = devDenied(session!)
      if (denied) return denied
      return (await drift.resetCharacter(actorFrom(session!), requestId(session!, 'dev:reset'))).message
    })

  ctx.command('drift.dev.give <item:string> [quantity:number]', '发放物品')
    .userFields(['authority'])
    .action(async ({ session }, item, quantity = 1) => {
      const denied = devDenied(session!)
      if (denied) return denied
      return (await drift.debugGiveItem(actorFrom(session!), item, quantity, requestId(session!, `dev:give:${item}`))).message
    })

  ctx.command('drift.dev.hp <value:number>', '设置生命值')
    .userFields(['authority'])
    .action(async ({ session }, value) => {
      const denied = devDenied(session!)
      if (denied) return denied
      return (await drift.debugSetStat(actorFrom(session!), 'hp', value, requestId(session!, 'dev:hp'))).message
    })

  ctx.command('drift.dev.ap <value:number>', '设置行动点')
    .userFields(['authority'])
    .action(async ({ session }, value) => {
      const denied = devDenied(session!)
      if (denied) return denied
      return (await drift.debugSetStat(actorFrom(session!), 'ap', value, requestId(session!, 'dev:ap'))).message
    })

  ctx.command('drift.dev.clear [eventId:string]', '清除事件进度')
    .userFields(['authority'])
    .action(async ({ session }, eventId) => {
      const denied = devDenied(session!)
      if (denied) return denied
      return (await drift.debugClearEvents(actorFrom(session!), eventId, requestId(session!, `dev:clear:${eventId ?? 'all'}`))).message
    })

  ctx.command('drift.dev.event <eventId:string> [variantId:string]', '直接触发事件')
    .userFields(['authority'])
    .action(async ({ session }, eventId, variantId) => {
      const denied = devDenied(session!)
      if (denied) return denied
      return (await drift.debugTriggerEvent(
        actorFrom(session!),
        eventId,
        variantId,
        requestId(session!, `dev:event:${eventId}:${variantId ?? 'auto'}`),
      )).message
    })

  ctx.command('drift.dev.check', '校验 JSON 内容')
    .userFields(['authority'])
    .action(async ({ session }) => {
      const denied = devDenied(session!)
      if (denied) return denied
      return renderContentReport(await drift.checkContent())
    })

  ctx.command('drift.dev.load', '热加载 JSON 内容')
    .userFields(['authority'])
    .action(async ({ session }) => {
      const denied = devDenied(session!)
      if (denied) return denied
      return renderContentReport(await drift.loadContent())
    })

  ctx.command('drift.dev.sync', '发布 JSON 内容到数据库')
    .userFields(['authority'])
    .action(async ({ session }) => {
      const denied = devDenied(session!)
      if (denied) return denied
      return renderContentReport(await drift.syncContent())
    })

  ctx.command('drift.dev.export <type:string> <contentId:string>', '导出有效内容到外部目录')
    .userFields(['authority'])
    .option('force', '--force 强制覆盖已有文件')
    .action(async ({ session, options: commandOptions }, type, contentId) => {
      const denied = devDenied(session!)
      if (denied) return denied
      if (!contentTypes.includes(type as ContentType)) return `内容类型必须是：${contentTypes.join('、')}`
      return renderContentReport(await drift.exportContent(type as ContentType, contentId, !!commandOptions?.force))
    })
}
