import type { Context } from 'koishi'
import type {
  CharacterStatus,
  ContentType,
  DeathCause,
  GameResult,
  PendingChoiceKind,
  PendingOption,
} from '../core/types'
import type { EventStateValue } from '../content/schema'

export interface DriftUser {
  id: number
  activeCharacterId: number | null
  revision: number
  createdAt: Date
  updatedAt: Date
}

export interface DriftIdentity {
  id: number
  userId: number
  platform: string
  platformUserId: string
  createdAt: Date
  lastSeenAt: Date
}

export interface DriftCharacter {
  id: number
  userId: number
  name: string
  status: CharacterStatus
  speciesId: string
  professionId: string
  regionId: string
  hp: number
  maxHp: number
  attack: number
  actionPoints: number
  maxActionPoints: number
  apDate: string
  provisionDate: string | null
  hungerDays: number
  revision: number
  deathCause: DeathCause | null
  deathDetail: string | null
  diedAt: Date | null
  createdAt: Date
  updatedAt: Date
}

export interface DriftInventory {
  characterId: number
  itemId: string
  quantity: number
  updatedAt: Date
}

export interface DriftCharacterBuilding {
  characterId: number
  regionId: string
  buildingId: string
  level: number
  createdAt: Date
  updatedAt: Date
}

export interface DriftPendingChoice {
  characterId: number
  kind: PendingChoiceKind
  sourceId: string
  sourceVersion: number
  variantId: string | null
  defaultOptionId: string | null
  options: PendingOption[]
  createdAt: Date
  expiresAt: Date | null
}

export interface DriftCharacterEvent {
  characterId: number
  eventId: string
  occurrenceCount: number
  lastTriggeredAt: Date | null
  cooldownUntil: Date | null
  lastChoiceId: string | null
  choiceCounts: Record<string, number>
  state: Record<string, EventStateValue>
  createdAt: Date
  updatedAt: Date
}

export interface DriftActionLog {
  id: number
  requestId: string
  userId: number
  characterId: number
  actionId: string
  input: Record<string, unknown>
  result: GameResult
  createdAt: Date
}

export interface DriftContent {
  id: number
  type: ContentType
  contentId: string
  version: number
  enabled: boolean
  data: any
  createdAt: Date
  updatedAt: Date
}

declare module 'koishi' {
  interface Tables {
    drift_user: DriftUser
    drift_identity: DriftIdentity
    drift_character: DriftCharacter
    drift_inventory: DriftInventory
    drift_character_building: DriftCharacterBuilding
    drift_pending_choice: DriftPendingChoice
    drift_character_event: DriftCharacterEvent
    drift_action_log: DriftActionLog
    drift_content: DriftContent
  }
}

export function defineModels(ctx: Context) {
  ctx.model.extend('drift_user', {
    id: 'unsigned',
    activeCharacterId: { type: 'unsigned', nullable: true },
    revision: { type: 'unsigned', initial: 0 },
    createdAt: 'timestamp',
    updatedAt: 'timestamp',
  }, {
    autoInc: true,
    unique: ['activeCharacterId'],
  })

  ctx.model.extend('drift_identity', {
    id: 'unsigned',
    userId: 'unsigned',
    platform: 'string(32)',
    platformUserId: 'string(128)',
    createdAt: 'timestamp',
    lastSeenAt: 'timestamp',
  }, {
    autoInc: true,
    unique: [['platform', 'platformUserId']],
    indexes: ['userId'],
  })

  ctx.model.extend('drift_character', {
    id: 'unsigned',
    userId: 'unsigned',
    name: 'string(32)',
    status: 'string(16)',
    speciesId: 'string(64)',
    professionId: 'string(64)',
    regionId: 'string(64)',
    hp: 'integer',
    maxHp: 'integer',
    attack: 'integer',
    actionPoints: 'integer',
    maxActionPoints: 'integer',
    apDate: 'char(10)',
    provisionDate: { type: 'char', length: 10, nullable: true },
    hungerDays: { type: 'unsigned', initial: 0 },
    revision: { type: 'unsigned', initial: 0 },
    deathCause: { type: 'string', length: 16, nullable: true },
    deathDetail: { type: 'text', nullable: true },
    diedAt: { type: 'timestamp', nullable: true },
    createdAt: 'timestamp',
    updatedAt: 'timestamp',
  }, {
    autoInc: true,
    indexes: [
      ['userId', 'status'],
      ['userId', 'createdAt'],
      ['status', 'regionId'],
    ],
  })

  ctx.model.extend('drift_inventory', {
    characterId: 'unsigned',
    itemId: 'string(64)',
    quantity: 'integer',
    updatedAt: 'timestamp',
  }, {
    primary: ['characterId', 'itemId'],
  })

  ctx.model.extend('drift_character_building', {
    characterId: 'unsigned',
    regionId: 'string(64)',
    buildingId: 'string(64)',
    level: { type: 'unsigned', initial: 1 },
    createdAt: 'timestamp',
    updatedAt: 'timestamp',
  }, {
    primary: ['characterId', 'regionId', 'buildingId'],
  })

  ctx.model.extend('drift_pending_choice', {
    characterId: 'unsigned',
    kind: 'string(16)',
    sourceId: 'string(64)',
    sourceVersion: 'unsigned',
    variantId: { type: 'string', length: 64, nullable: true },
    defaultOptionId: { type: 'string', length: 64, nullable: true },
    options: 'json',
    createdAt: 'timestamp',
    expiresAt: { type: 'timestamp', nullable: true },
  }, {
    primary: 'characterId',
  })

  ctx.model.extend('drift_character_event', {
    characterId: 'unsigned',
    eventId: 'string(64)',
    occurrenceCount: { type: 'unsigned', initial: 0 },
    lastTriggeredAt: { type: 'timestamp', nullable: true },
    cooldownUntil: { type: 'timestamp', nullable: true },
    lastChoiceId: { type: 'string', length: 64, nullable: true },
    choiceCounts: { type: 'json', initial: {} },
    state: { type: 'json', initial: {} },
    createdAt: 'timestamp',
    updatedAt: 'timestamp',
  }, {
    primary: ['characterId', 'eventId'],
    indexes: [['eventId', 'cooldownUntil']],
  })

  ctx.model.extend('drift_action_log', {
    id: 'unsigned',
    requestId: 'string(191)',
    userId: 'unsigned',
    characterId: 'unsigned',
    actionId: 'string(64)',
    input: 'json',
    result: 'json',
    createdAt: 'timestamp',
  }, {
    autoInc: true,
    unique: ['requestId'],
    indexes: [
      ['characterId', 'createdAt'],
      ['userId', 'createdAt'],
    ],
  })

  ctx.model.extend('drift_content', {
    id: 'unsigned',
    type: 'string(16)',
    contentId: 'string(64)',
    version: { type: 'unsigned', initial: 1 },
    enabled: { type: 'boolean', initial: true },
    data: 'json',
    createdAt: 'timestamp',
    updatedAt: 'timestamp',
  }, {
    autoInc: true,
    unique: [['type', 'contentId']],
    indexes: [['type', 'enabled']],
  })
}
