import { randomUUID } from 'node:crypto'
import type { Command, Context, Session } from 'koishi'
import type { ActorIdentity, CampView, CharacterHistory, GameSnapshot, InventoryView } from '../core/types'
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
  'craft:ration': 'drift craft ration',
  'build:shelter': 'drift build shelter',
}

function renderInventory(view: InventoryView) {
  if (!view.characterId) return '你还没有存活角色。'
  if (!view.items.length) return '背包是空的。'
  return ['背包：', ...view.items.map(item => `- ${item.name} x ${item.quantity}`)].join('\n')
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

export function registerCommands(ctx: Context, drift: DriftService) {
  ctx.middleware(async (session, next) => {
    const content = session.content?.trim() ?? ''
    if (!/^[1-9]\d*$/.test(content) || !session.userId) return next()
    const result = await drift.resolveChoiceByIndex(
      actorFrom(session),
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
          ...actions.map(action => `${action.index}. ${action.label}`),
          '请直接发送数字选择。',
        ].join('\n')
      }
      return actions.map(action => {
        const command = actionCommands[action.actionId] ?? action.actionId
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
      const normalized = item?.trim().toLowerCase()
      if (normalized && normalized !== 'ration' && normalized !== '口粮') {
        return '第一版只能制作口粮。使用 drift craft ration。'
      }
      const result = await drift.executeAction(actorFrom(session!), 'craft:ration', requestId(session!, 'craft:ration'))
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
}
