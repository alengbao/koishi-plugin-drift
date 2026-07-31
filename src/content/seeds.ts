import { ContentDefinition } from './schema'

export type SeedContentDefinition = ContentDefinition & { version: number }

export const seedContent: SeedContentDefinition[] = [
  {
    type: 'region',
    contentId: 'forest',
    version: 1,
    data: {
      name: '森林',
      description: '潮湿而寂静的林地。',
      collect: {
        apCost: 1,
        drops: [{ itemId: 'wood', quantity: 1, weight: 1 }],
      },
      explore: {
        apCost: 1,
        eventPool: [{ eventId: 'forest-rustle', weight: 1 }],
      },
      buildingIds: ['shelter'],
    },
  },
  {
    type: 'item',
    contentId: 'wood',
    version: 1,
    data: {
      name: '木材',
      description: '可以用于制作和建造的普通木材。',
      kind: 'resource',
    },
  },
  {
    type: 'item',
    contentId: 'ration',
    version: 1,
    data: {
      name: '口粮',
      description: '开始一天行动时自动消耗。',
      kind: 'food',
      nutrition: 1,
      recipe: {
        apCost: 1,
        ingredients: [{ itemId: 'wood', quantity: 2 }],
        outputQuantity: 1,
      },
    },
  },
  {
    type: 'enemy',
    contentId: 'wild-rat',
    version: 1,
    data: {
      name: '野鼠',
      description: '一只护食的野鼠。',
      maxHp: 2,
      attack: 1,
      rewards: [{ itemId: 'wood', quantity: 1 }],
    },
  },
  {
    type: 'building',
    contentId: 'shelter',
    version: 1,
    data: {
      name: '庇护所',
      description: '一个简陋但属于你的落脚点。',
      allowedRegionIds: ['forest'],
      apCost: 1,
      costs: [{ itemId: 'wood', quantity: 3 }],
      maxLevel: 1,
      effect: { type: 'none' },
    },
  },
  {
    type: 'event',
    contentId: 'forest-rustle',
    version: 1,
    data: {
      name: '灌木中的动静',
      description: '前方的灌木突然剧烈摇晃。',
      regionIds: ['forest'],
      choices: [
        { id: 'investigate', label: '上前调查', outcome: { type: 'combat', enemyId: 'wild-rat' } },
        { id: 'leave', label: '悄悄离开', outcome: { type: 'nothing', message: '你避开了未知的麻烦。' } },
      ],
    },
  },
]
