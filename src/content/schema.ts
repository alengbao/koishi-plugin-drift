import { z } from 'zod'

const id = z.string().min(1).max(64)
const positiveInteger = z.number().int().positive()
const nonNegativeInteger = z.number().int().nonnegative()
const stateValue = z.union([z.boolean(), z.number().int(), z.string().max(128)])

const itemQuantity = z.object({
  itemId: id,
  quantity: positiveInteger,
})

const weightedItem = z.object({
  itemId: id,
  quantity: positiveInteger,
  weight: positiveInteger,
})

const weightedEvent = z.object({
  eventId: id,
  weight: positiveInteger,
})

const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const comparison = z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte'])

export const eventConditionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('localTime'), start: localTime, end: localTime }),
  z.object({ type: z.literal('inventory'), itemId: id, quantity: positiveInteger }),
  z.object({ type: z.literal('capability'), capability: id }),
  z.object({ type: z.literal('hp'), operator: comparison, value: nonNegativeInteger }),
  z.object({ type: z.literal('eventState'), key: id, operator: comparison, value: stateValue }),
])

export const eventEffectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('gainItem'), itemId: id, quantity: positiveInteger }),
  z.object({ type: z.literal('consumeItem'), itemId: id, quantity: positiveInteger }),
  z.object({ type: z.literal('adjustHp'), amount: z.number().int().refine(value => value !== 0) }),
  z.object({ type: z.literal('setState'), key: id, value: stateValue }),
  z.object({ type: z.literal('incrementState'), key: id, amount: z.number().int().refine(value => value !== 0) }),
])

export const eventOutcomeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('nothing'), message: z.string() }),
  // Kept for stored v1 content and pending choice snapshots.
  z.object({
    type: z.literal('gainItem'),
    itemId: id,
    quantity: positiveInteger,
    message: z.string(),
  }),
  z.object({ type: z.literal('combat'), enemyId: id }),
  z.object({
    type: z.literal('effects'),
    effects: z.array(eventEffectSchema).min(1),
    message: z.string(),
  }),
])

export const eventChoiceSchema = z.object({
  id,
  label: z.string().min(1),
  conditions: z.array(eventConditionSchema).default([]),
  disabledReason: z.string().min(1).optional(),
  default: z.boolean().default(false),
  outcome: eventOutcomeSchema,
}).superRefine((choice, ctx) => {
  if (choice.default && choice.conditions.length) {
    ctx.addIssue({ code: 'custom', message: '默认选项不能包含条件', path: ['conditions'] })
  }
  if (choice.conditions.length && !choice.disabledReason) {
    ctx.addIssue({ code: 'custom', message: '有条件的选项必须提供 disabledReason', path: ['disabledReason'] })
  }
})

export const eventVariantSchema = z.object({
  id,
  name: z.string().min(1).optional(),
  description: z.string(),
  occurrence: z.object({
    min: positiveInteger,
    max: positiveInteger.optional(),
  }).optional(),
  conditions: z.array(eventConditionSchema).default([]),
  weight: positiveInteger.default(1),
  choices: z.array(eventChoiceSchema).min(1),
}).superRefine((variant, ctx) => {
  if (variant.occurrence?.max !== undefined && variant.occurrence.max < variant.occurrence.min) {
    ctx.addIssue({ code: 'custom', message: '次数范围的 max 不能小于 min', path: ['occurrence', 'max'] })
  }
  if (variant.choices.filter(choice => choice.default).length !== 1) {
    ctx.addIssue({ code: 'custom', message: '每个事件表现必须恰好有一个默认选项', path: ['choices'] })
  }
  const choiceIds = new Set<string>()
  for (const [index, choice] of variant.choices.entries()) {
    if (choiceIds.has(choice.id)) {
      ctx.addIssue({ code: 'custom', message: `重复的事件选项 ID：${choice.id}`, path: ['choices', index, 'id'] })
    }
    choiceIds.add(choice.id)
  }
})

export const regionDataSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  collect: z.object({
    apCost: positiveInteger,
    drops: z.array(weightedItem).min(1),
  }),
  explore: z.object({
    apCost: positiveInteger,
    eventPool: z.array(weightedEvent).min(1),
  }),
  buildingIds: z.array(id),
})

export const itemDataSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  kind: z.enum(['resource', 'food', 'tool']),
  capabilities: z.array(id).default([]),
  nutrition: positiveInteger.optional(),
  recipe: z.object({
    apCost: positiveInteger,
    ingredients: z.array(itemQuantity).min(1),
    outputQuantity: positiveInteger,
  }).optional(),
})

export const enemyDataSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  maxHp: positiveInteger,
  attack: nonNegativeInteger,
  rewards: z.array(itemQuantity),
})

export const buildingDataSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  allowedRegionIds: z.array(id).min(1),
  apCost: positiveInteger,
  costs: z.array(itemQuantity).min(1),
  maxLevel: positiveInteger,
  effect: z.object({ type: z.literal('none') }),
})

const modernEventDataSchema = z.object({
  name: z.string().min(1),
  regionIds: z.array(id).min(1),
  conditions: z.array(eventConditionSchema).default([]),
  maxOccurrences: positiveInteger.optional(),
  cooldownMs: nonNegativeInteger.default(0),
  fallbackVariantId: id,
  variants: z.array(eventVariantSchema).min(1),
}).superRefine((event, ctx) => {
  const ids = new Set<string>()
  for (const [index, variant] of event.variants.entries()) {
    if (ids.has(variant.id)) {
      ctx.addIssue({ code: 'custom', message: `重复的事件表现 ID：${variant.id}`, path: ['variants', index, 'id'] })
    }
    ids.add(variant.id)
  }
  if (!ids.has(event.fallbackVariantId)) {
    ctx.addIssue({ code: 'custom', message: 'fallbackVariantId 必须引用一个事件表现', path: ['fallbackVariantId'] })
  }
})

const legacyEventDataSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  regionIds: z.array(id).min(1),
  choices: z.array(z.object({
    id,
    label: z.string().min(1),
    outcome: eventOutcomeSchema,
  })).min(1),
})

type ModernEventData = z.infer<typeof modernEventDataSchema>

export const eventDataSchema = z.union([modernEventDataSchema, legacyEventDataSchema])
  .transform((event): ModernEventData => {
    if ('variants' in event) return event
    const defaultId = event.choices.find(choice => choice.id === 'leave')?.id
      ?? event.choices[event.choices.length - 1].id
    return {
      name: event.name,
      regionIds: event.regionIds,
      conditions: [],
      cooldownMs: 0,
      fallbackVariantId: 'legacy',
      variants: [{
        id: 'legacy',
        description: event.description,
        conditions: [],
        weight: 1,
        choices: event.choices.map(choice => ({
          ...choice,
          conditions: [],
          default: choice.id === defaultId,
        })),
      }],
    }
  })

export const contentDefinitionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('region'), contentId: id, data: regionDataSchema }),
  z.object({ type: z.literal('item'), contentId: id, data: itemDataSchema }),
  z.object({ type: z.literal('enemy'), contentId: id, data: enemyDataSchema }),
  z.object({ type: z.literal('building'), contentId: id, data: buildingDataSchema }),
  z.object({ type: z.literal('event'), contentId: id, data: eventDataSchema }),
])

export const contentFileSchema = z.intersection(
  z.object({
    $schema: z.string().optional(),
    version: positiveInteger,
  }),
  contentDefinitionSchema,
)

export type ContentDefinition = z.infer<typeof contentDefinitionSchema>
export type ContentFileDefinition = z.infer<typeof contentFileSchema>
export type RegionData = z.infer<typeof regionDataSchema>
export type ItemData = z.infer<typeof itemDataSchema>
export type EnemyData = z.infer<typeof enemyDataSchema>
export type BuildingData = z.infer<typeof buildingDataSchema>
export type EventData = z.infer<typeof eventDataSchema>
export type EventCondition = z.infer<typeof eventConditionSchema>
export type EventEffect = z.infer<typeof eventEffectSchema>
export type EventOutcome = z.infer<typeof eventOutcomeSchema>
export type EventChoice = z.infer<typeof eventChoiceSchema>
export type EventVariant = z.infer<typeof eventVariantSchema>
export type EventStateValue = z.infer<typeof stateValue>
