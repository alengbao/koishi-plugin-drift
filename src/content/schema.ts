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

const locationPoolEntry = z.object({
  locationId: id,
  weight: positiveInteger,
  min: nonNegativeInteger,
  max: positiveInteger,
}).superRefine((entry, ctx) => {
  if (entry.max < entry.min) {
    ctx.addIssue({ code: 'custom', message: '地点池的 max 不能小于 min', path: ['max'] })
  }
})

const localTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
const comparison = z.enum(['eq', 'ne', 'gt', 'gte', 'lt', 'lte'])

const localTimeCondition = z.object({ type: z.literal('localTime'), start: localTime, end: localTime })
const inventoryCondition = z.object({ type: z.literal('inventory'), itemId: id, quantity: positiveInteger })
const capabilityCondition = z.object({ type: z.literal('capability'), capability: id })
const hpCondition = z.object({ type: z.literal('hp'), operator: comparison, value: nonNegativeInteger })

export const eventConditionSchema = z.discriminatedUnion('type', [
  localTimeCondition,
  inventoryCondition,
  capabilityCondition,
  hpCondition,
  z.object({ type: z.literal('eventState'), key: id, operator: comparison, value: stateValue }),
])

export const locationConditionSchema = z.discriminatedUnion('type', [
  localTimeCondition,
  inventoryCondition,
  capabilityCondition,
  hpCondition,
  z.object({ type: z.literal('locationState'), key: id, operator: comparison, value: stateValue }),
])

export const eventEffectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('gainItem'), itemId: id, quantity: positiveInteger }),
  z.object({ type: z.literal('consumeItem'), itemId: id, quantity: positiveInteger }),
  z.object({ type: z.literal('adjustHp'), amount: z.number().int().refine(value => value !== 0) }),
  z.object({ type: z.literal('setState'), key: id, value: stateValue }),
  z.object({ type: z.literal('incrementState'), key: id, amount: z.number().int().refine(value => value !== 0) }),
])

export const locationEffectSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('gainItem'), itemId: id, quantity: positiveInteger }),
  z.object({ type: z.literal('consumeItem'), itemId: id, quantity: positiveInteger }),
  z.object({ type: z.literal('adjustHp'), amount: z.number().int().refine(value => value !== 0) }),
  z.object({ type: z.literal('setLocationState'), key: id, value: stateValue }),
  z.object({ type: z.literal('incrementLocationState'), key: id, amount: z.number().int().refine(value => value !== 0) }),
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
  map: z.object({
    ringSize: z.literal(7),
    locationCount: z.object({ min: positiveInteger, max: positiveInteger }),
    locationPool: z.array(locationPoolEntry).min(1),
  }).optional().superRefine((map, ctx) => {
    if (!map) return
    if (map.locationCount.max < map.locationCount.min) {
      ctx.addIssue({ code: 'custom', message: '地点数量 max 不能小于 min', path: ['locationCount', 'max'] })
    }
    if (map.locationCount.max > map.ringSize * 8) {
      ctx.addIssue({ code: 'custom', message: '地点数量超过地图允许上限', path: ['locationCount', 'max'] })
    }
    const ids = new Set<string>()
    let minTotal = 0
    let maxTotal = 0
    for (const [index, entry] of map.locationPool.entries()) {
      if (ids.has(entry.locationId)) {
        ctx.addIssue({ code: 'custom', message: `重复的地点 ID：${entry.locationId}`, path: ['locationPool', index, 'locationId'] })
      }
      ids.add(entry.locationId)
      minTotal += entry.min
      maxTotal += entry.max
    }
    if (minTotal > map.locationCount.max) {
      ctx.addIssue({ code: 'custom', message: '地点池最小数量超过地点总数上限', path: ['locationPool'] })
    }
    if (maxTotal < map.locationCount.min) {
      ctx.addIssue({ code: 'custom', message: '地点池最大数量不足以满足地点总数下限', path: ['locationPool'] })
    }
  }),
})

const itemBase = {
  name: z.string().min(1),
  description: z.string(),
  capabilities: z.array(id).default([]),
  recipe: z.object({
    apCost: positiveInteger,
    ingredients: z.array(itemQuantity).min(1),
    outputQuantity: positiveInteger,
  }).optional(),
}

export const itemDataSchema = z.discriminatedUnion('kind', [
  z.object({ ...itemBase, kind: z.literal('resource') }),
  z.object({
    ...itemBase,
    kind: z.literal('food'),
    nutrition: positiveInteger.default(1),
    shelfLifeDays: positiveInteger.nullable().default(null),
  }),
  z.object({ ...itemBase, kind: z.literal('tool') }),
])

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

export const locationInteractionSchema = z.object({
  id,
  label: z.string().min(1),
  description: z.string().min(1),
  apCost: positiveInteger,
  cooldown: z.object({
    type: z.literal('localDate'),
    days: positiveInteger,
  }).nullable().default(null),
  conditions: z.array(locationConditionSchema).default([]),
  disabledReason: z.string().min(1).optional(),
  outcome: z.object({
    type: z.literal('effects'),
    effects: z.array(locationEffectSchema).min(1),
    message: z.string().min(1),
  }),
}).superRefine((interaction, ctx) => {
  if (interaction.conditions.length && !interaction.disabledReason) {
    ctx.addIssue({ code: 'custom', message: '有条件的地点互动必须提供 disabledReason', path: ['disabledReason'] })
  }
})

export const locationDataSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  regionIds: z.array(id).min(1),
  interactions: z.array(locationInteractionSchema).min(1),
}).superRefine((location, ctx) => {
  const ids = new Set<string>()
  for (const [index, interaction] of location.interactions.entries()) {
    if (ids.has(interaction.id)) {
      ctx.addIssue({ code: 'custom', message: `重复的地点互动 ID：${interaction.id}`, path: ['interactions', index, 'id'] })
    }
    ids.add(interaction.id)
  }
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
  z.object({ type: z.literal('location'), contentId: id, data: locationDataSchema }),
  z.object({ type: z.literal('event'), contentId: id, data: eventDataSchema }),
])

// Keep the file metadata in every discriminated branch. An outer intersection
// makes zod-to-json-schema emit `additionalProperties: false` branches that do
// not see `$schema` and `version`, causing false editor diagnostics.
const contentFileMetadata = {
  $schema: z.string().optional(),
  version: positiveInteger,
}

export const contentFileSchema = z.discriminatedUnion('type', [
  z.object({ ...contentFileMetadata, type: z.literal('region'), contentId: id, data: regionDataSchema }),
  z.object({ ...contentFileMetadata, type: z.literal('item'), contentId: id, data: itemDataSchema }),
  z.object({ ...contentFileMetadata, type: z.literal('enemy'), contentId: id, data: enemyDataSchema }),
  z.object({ ...contentFileMetadata, type: z.literal('building'), contentId: id, data: buildingDataSchema }),
  z.object({ ...contentFileMetadata, type: z.literal('location'), contentId: id, data: locationDataSchema }),
  z.object({ ...contentFileMetadata, type: z.literal('event'), contentId: id, data: eventDataSchema }),
])

export type ContentDefinition = z.infer<typeof contentDefinitionSchema>
export type ContentFileDefinition = z.infer<typeof contentFileSchema>
export type RegionData = z.infer<typeof regionDataSchema>
export type ItemData = z.infer<typeof itemDataSchema>
export type EnemyData = z.infer<typeof enemyDataSchema>
export type BuildingData = z.infer<typeof buildingDataSchema>
export type LocationData = z.infer<typeof locationDataSchema>
export type LocationInteraction = z.infer<typeof locationInteractionSchema>
export type EventData = z.infer<typeof eventDataSchema>
export type EventCondition = z.infer<typeof eventConditionSchema>
export type LocationCondition = z.infer<typeof locationConditionSchema>
export type EventEffect = z.infer<typeof eventEffectSchema>
export type LocationEffect = z.infer<typeof locationEffectSchema>
export type EventOutcome = z.infer<typeof eventOutcomeSchema>
export type EventChoice = z.infer<typeof eventChoiceSchema>
export type EventVariant = z.infer<typeof eventVariantSchema>
export type EventStateValue = z.infer<typeof stateValue>
