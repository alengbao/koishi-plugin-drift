import { z } from 'zod'

const id = z.string().min(1).max(64)
const positiveInteger = z.number().int().positive()
const nonNegativeInteger = z.number().int().nonnegative()

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

export const eventOutcomeSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('nothing'), message: z.string() }),
  z.object({
    type: z.literal('gainItem'),
    itemId: id,
    quantity: positiveInteger,
    message: z.string(),
  }),
  z.object({ type: z.literal('combat'), enemyId: id }),
])

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
  kind: z.enum(['resource', 'food']),
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

export const eventDataSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  regionIds: z.array(id).min(1),
  choices: z.array(z.object({
    id,
    label: z.string().min(1),
    outcome: eventOutcomeSchema,
  })).min(1),
})

export const contentDefinitionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('region'), contentId: id, data: regionDataSchema }),
  z.object({ type: z.literal('item'), contentId: id, data: itemDataSchema }),
  z.object({ type: z.literal('enemy'), contentId: id, data: enemyDataSchema }),
  z.object({ type: z.literal('building'), contentId: id, data: buildingDataSchema }),
  z.object({ type: z.literal('event'), contentId: id, data: eventDataSchema }),
])

export type ContentDefinition = z.infer<typeof contentDefinitionSchema>
export type RegionData = z.infer<typeof regionDataSchema>
export type ItemData = z.infer<typeof itemDataSchema>
export type EnemyData = z.infer<typeof enemyDataSchema>
export type BuildingData = z.infer<typeof buildingDataSchema>
export type EventData = z.infer<typeof eventDataSchema>
