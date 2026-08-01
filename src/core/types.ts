import type { EventCondition, EventOutcome } from '../content/schema'

export const contentTypes = ['region', 'item', 'enemy', 'building', 'event'] as const
export type ContentType = typeof contentTypes[number]

export type CharacterStatus = 'active' | 'dead'
export type DeathCause = 'combat' | 'hunger' | 'suicide' | 'event'
export type PendingChoiceKind = 'event' | 'suicide'

export interface ActorIdentity {
  platform: string
  platformUserId: string
}

export interface ActionOption {
  index: number
  actionId: string
  label: string
  enabled: boolean
  disabledReason?: string
  apCost: number
}

export interface CharacterSnapshot {
  id: number
  name: string
  speciesId: string
  professionId: string
  regionId: string
  hp: number
  maxHp: number
  actionPoints: number
  maxActionPoints: number
  hungerDays: number
}

export interface GameSnapshot {
  character: CharacterSnapshot | null
  pendingTitle?: string
  pendingExpiresAt?: Date
}

export interface InventoryEntry {
  itemId: string
  name: string
  quantity: number
  acquiredOn?: string
  expiresOn?: string | null
}

export interface SpoiledInventoryEntry {
  itemId: string
  name: string
  quantity: number
}

export interface InventoryView {
  characterId: number | null
  items: InventoryEntry[]
  spoiled: SpoiledInventoryEntry[]
}

export interface CampEntry {
  buildingId: string
  name: string
  regionId: string
  level: number
}

export interface CampView {
  characterId: number | null
  buildings: CampEntry[]
}

export interface HistoryEntry {
  id: number
  name: string
  deathCause: DeathCause
  deathDetail: string | null
  diedAt: Date
}

export interface CharacterHistory {
  total: number
  characters: HistoryEntry[]
}

export interface GameResult {
  ok: boolean
  code: string
  message: string
  snapshot?: GameSnapshot
}

export interface ContentReport {
  ok: boolean
  code: string
  message: string
  builtinCount?: number
  externalCount?: number
  totalCount?: number
  inserted?: number
  updated?: number
  skipped?: number
  mode?: 'source' | 'bundle'
  path?: string
}

export type PendingOutcome = EventOutcome | { type: 'suicideConfirm' } | { type: 'cancel' }

export interface PendingOption {
  id: string
  label: string
  outcome: PendingOutcome
  conditions?: EventCondition[]
  enabled?: boolean
  disabledReason?: string
  default?: boolean
}
