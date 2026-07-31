import { ContentDefinition } from './schema'

export type SeedContentDefinition = ContentDefinition & { version: number }

const hour = 60 * 60 * 1000

export const seedContent: SeedContentDefinition[] = [
  {
    type: 'region',
    contentId: 'forest',
    version: 2,
    data: {
      name: '森林',
      description: '潮湿而寂静的林地。',
      collect: {
        apCost: 1,
        drops: [
          { itemId: 'wood', quantity: 1, weight: 3 },
          { itemId: 'stone', quantity: 1, weight: 1 },
        ],
      },
      explore: {
        apCost: 1,
        eventPool: [
          { eventId: 'forest-trapped-animal', weight: 4 },
          { eventId: 'forest-strange-fungi', weight: 5 },
          { eventId: 'forest-fallen-tree', weight: 3 },
          { eventId: 'forest-night-glow', weight: 4 },
          { eventId: 'forest-tree-hole-creature', weight: 2 },
          { eventId: 'forest-rustle', weight: 1 },
        ],
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
      capabilities: [],
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
      capabilities: [],
      nutrition: 1,
      recipe: {
        apCost: 1,
        ingredients: [{ itemId: 'wood', quantity: 2 }],
        outputQuantity: 1,
      },
    },
  },
  {
    type: 'item',
    contentId: 'stone',
    version: 1,
    data: {
      name: '石块',
      description: '能够打磨成简单工具的坚硬石块。',
      kind: 'resource',
      capabilities: [],
    },
  },
  {
    type: 'item',
    contentId: 'stone-axe',
    version: 1,
    data: {
      name: '石斧',
      description: '粗糙但足以切割木材的石制工具。',
      kind: 'tool',
      capabilities: ['cut-wood'],
      recipe: {
        apCost: 1,
        ingredients: [
          { itemId: 'wood', quantity: 2 },
          { itemId: 'stone', quantity: 1 },
        ],
        outputQuantity: 1,
      },
    },
  },
  {
    type: 'item',
    contentId: 'wild-mushroom',
    version: 1,
    data: {
      name: '野生菌',
      description: '来自林地菌群的食材，是否安全仍需谨慎判断。',
      kind: 'food',
      capabilities: [],
      nutrition: 1,
    },
  },
  {
    type: 'item',
    contentId: 'glow-moss',
    version: 1,
    data: {
      name: '发光苔',
      description: '在黑暗中散发微弱冷光的潮湿苔藓。',
      kind: 'resource',
      capabilities: [],
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
    version: 2,
    data: {
      name: '灌木中的动静',
      regionIds: ['forest'],
      conditions: [],
      cooldownMs: 24 * hour,
      fallbackVariantId: 'main',
      variants: [{
        id: 'main',
        description: '前方的灌木突然剧烈摇晃。',
        conditions: [],
        weight: 1,
        choices: [
          {
            id: 'investigate',
            label: '上前调查',
            conditions: [],
            default: false,
            outcome: { type: 'combat', enemyId: 'wild-rat' },
          },
          {
            id: 'leave',
            label: '悄悄离开',
            conditions: [],
            default: true,
            outcome: { type: 'nothing', message: '你避开了未知的麻烦。' },
          },
        ],
      }],
    },
  },
  {
    type: 'event',
    contentId: 'forest-trapped-animal',
    version: 1,
    data: {
      name: '被困的小兽',
      regionIds: ['forest'],
      conditions: [],
      maxOccurrences: 3,
      cooldownMs: 24 * hour,
      fallbackVariantId: 'third',
      variants: [
        trappedAnimalVariant('first', 1, '一只灰兔被旧绳套勒住后腿，正徒劳地挣扎。'),
        trappedAnimalVariant('second', 2, '一只幼小的林鸟被细藤缠在低矮枝杈间。'),
        trappedAnimalVariant('third', 3, '灌木下又有一只受困的小兽，陷阱周围没有留下主人踪迹。'),
      ],
    },
  },
  {
    type: 'event',
    contentId: 'forest-strange-fungi',
    version: 1,
    data: {
      name: '奇怪的菌群',
      regionIds: ['forest'],
      conditions: [],
      cooldownMs: 12 * hour,
      fallbackVariantId: 'edible',
      variants: [
        {
          id: 'edible',
          description: '倒木背阴处长着一簇气味温和的浅褐色菌伞。',
          conditions: [],
          weight: 3,
          choices: fungusChoices(2, false),
        },
        {
          id: 'dense',
          description: '潮湿洼地里挤满了肥厚的菌伞，看起来可以收获不少。',
          conditions: [],
          weight: 2,
          choices: fungusChoices(3, false),
        },
        {
          id: 'irritating',
          description: '斑驳菌群喷出辛辣孢子，靠近它可能会受伤。',
          conditions: [],
          weight: 1,
          choices: fungusChoices(1, true),
        },
      ],
    },
  },
  {
    type: 'event',
    contentId: 'forest-fallen-tree',
    version: 1,
    data: {
      name: '倒下的巨树',
      regionIds: ['forest'],
      conditions: [],
      maxOccurrences: 3,
      cooldownMs: 48 * hour,
      fallbackVariantId: 'third',
      variants: [
        fallenTreeVariant('first', 1, '一棵刚倒下的巨树横在林间，断面仍带着清新的木香。', 2, 6),
        fallenTreeVariant('second', 2, '那棵巨树已经开始干燥，仍有不少完好的木料。', 1, 4),
        fallenTreeVariant('third', 3, '巨树只剩下一部分坚硬主干，能利用的材料已经不多。', 1, 2),
      ],
    },
  },
  {
    type: 'event',
    contentId: 'forest-night-glow',
    version: 1,
    data: {
      name: '夜间微光',
      regionIds: ['forest'],
      conditions: [{ type: 'localTime', start: '20:00', end: '06:00' }],
      cooldownMs: 20 * hour,
      fallbackVariantId: 'moss',
      variants: [
        {
          id: 'moss',
          description: '树根间覆着一片散发冷光的苔藓。',
          conditions: [],
          weight: 3,
          choices: nightGlowChoices(2, false),
        },
        {
          id: 'spores',
          description: '蓝白色孢子在空气中起伏，靠近时皮肤隐隐刺痛。',
          conditions: [],
          weight: 2,
          choices: nightGlowChoices(1, true),
        },
        {
          id: 'fireflies',
          description: '一群萤光小虫绕着空心树桩缓慢盘旋。',
          conditions: [],
          weight: 1,
          choices: [
            {
              id: 'observe',
              label: '静静观察',
              conditions: [],
              default: false,
              outcome: { type: 'nothing', message: '你记住了萤光小虫飞行的轨迹。' },
            },
            safeLeave('leave-glow'),
          ],
        },
      ],
    },
  },
  {
    type: 'event',
    contentId: 'forest-tree-hole-creature',
    version: 1,
    data: {
      name: '树洞中的无名生物',
      regionIds: ['forest'],
      conditions: [],
      maxOccurrences: 3,
      cooldownMs: 24 * hour,
      fallbackVariantId: 'third',
      variants: [
        treeCreatureVariant('first', 1, '树洞深处亮着一双眼睛，一只小爪谨慎地伸了出来。', 'ration', 1, [
          { type: 'gainItem', itemId: 'stone', quantity: 2 },
        ]),
        treeCreatureVariant('second', 2, '那双眼睛再次出现，树洞口摆着几缕发光苔。', 'wild-mushroom', 1, [
          { type: 'gainItem', itemId: 'glow-moss', quantity: 2 },
        ]),
        treeCreatureVariant('third', 3, '无名生物已经不再躲藏，只在树洞边等待你的交换。', 'ration', 1, [
          { type: 'gainItem', itemId: 'stone', quantity: 3 },
          { type: 'gainItem', itemId: 'glow-moss', quantity: 1 },
        ]),
      ],
    },
  },
]

function safeLeave(id: string) {
  return {
    id,
    label: '安全离开',
    conditions: [],
    default: true,
    outcome: { type: 'nothing' as const, message: '你没有打扰这里，转身离开了。' },
  }
}

function trappedAnimalVariant(id: string, occurrence: number, description: string) {
  return {
    id,
    description,
    occurrence: { min: occurrence, max: occurrence },
    conditions: [],
    weight: 1,
    choices: [
      {
        id: 'release',
        label: '解开束缚',
        conditions: [],
        default: false,
        outcome: { type: 'nothing' as const, message: '小兽恢复自由，很快消失在灌木后。' },
      },
      {
        id: 'take-food',
        label: '带走作为食物',
        conditions: [],
        default: false,
        outcome: {
          type: 'effects' as const,
          effects: [{ type: 'gainItem' as const, itemId: 'ration', quantity: 1 }],
          message: '你把猎物处理成了 1 份口粮。',
        },
      },
      safeLeave('leave'),
    ],
  }
}

function fungusChoices(quantity: number, harmful: boolean) {
  const conditions = harmful ? [{ type: 'hp' as const, operator: 'gte' as const, value: 2 }] : []
  const damage = harmful ? [{ type: 'adjustHp' as const, amount: -1 }] : []
  return [
    {
      id: 'collect',
      label: '小心采集',
      conditions,
      disabledReason: harmful ? '生命不足，无法冒险接近刺激性孢子' : undefined,
      default: false,
      outcome: {
        type: 'effects' as const,
        effects: [
          { type: 'gainItem' as const, itemId: 'wild-mushroom', quantity },
          ...damage,
        ],
        message: harmful
          ? `你忍着孢子的刺激采到了 ${quantity} 份野生菌，但失去了 1 点生命。`
          : `你采到了 ${quantity} 份野生菌。`,
      },
    },
    {
      id: 'taste',
      label: '尝一点',
      conditions,
      disabledReason: harmful ? '生命不足，不能冒险品尝' : undefined,
      default: false,
      outcome: {
        type: 'effects' as const,
        effects: [{ type: 'adjustHp' as const, amount: harmful ? -1 : 1 }],
        message: harmful ? '辛辣的汁液让你失去了 1 点生命。' : '菌肉味道温和，你恢复了 1 点生命。',
      },
    },
    safeLeave('leave'),
  ]
}

function fallenTreeVariant(
  id: string,
  occurrence: number,
  description: string,
  looseWood: number,
  cutWood: number,
) {
  return {
    id,
    description,
    occurrence: { min: occurrence, max: occurrence },
    conditions: [],
    weight: 1,
    choices: [
      {
        id: 'loose-wood',
        label: '收集松散枝木',
        conditions: [],
        default: false,
        outcome: {
          type: 'effects' as const,
          effects: [{ type: 'gainItem' as const, itemId: 'wood', quantity: looseWood }],
          message: `你收集到了 ${looseWood} 份木材。`,
        },
      },
      {
        id: 'cut-trunk',
        label: '切割主干',
        conditions: [{ type: 'capability' as const, capability: 'cut-wood' }],
        disabledReason: '需要能够切割木材的工具',
        default: false,
        outcome: {
          type: 'effects' as const,
          effects: [{ type: 'gainItem' as const, itemId: 'wood', quantity: cutWood }],
          message: `你借助工具取得了 ${cutWood} 份木材。`,
        },
      },
      safeLeave('leave'),
    ],
  }
}

function nightGlowChoices(quantity: number, harmful: boolean) {
  const conditions = harmful ? [{ type: 'hp' as const, operator: 'gte' as const, value: 2 }] : []
  return [
    {
      id: 'collect-glow',
      label: '靠近采集',
      conditions,
      disabledReason: harmful ? '生命不足，无法冒险接近刺痛的孢子' : undefined,
      default: false,
      outcome: {
        type: 'effects' as const,
        effects: [
          { type: 'gainItem' as const, itemId: 'glow-moss', quantity },
          ...(harmful ? [{ type: 'adjustHp' as const, amount: -1 }] : []),
        ],
        message: harmful
          ? `你采到了 ${quantity} 份发光苔，但失去了 1 点生命。`
          : `你采到了 ${quantity} 份发光苔。`,
      },
    },
    {
      id: 'observe',
      label: '在远处观察',
      conditions: [],
      default: false,
      outcome: { type: 'nothing' as const, message: '你在安全距离观察了这片微光。' },
    },
    safeLeave('leave'),
  ]
}

function treeCreatureVariant(
  id: string,
  occurrence: number,
  description: string,
  paymentItemId: 'ration' | 'wild-mushroom',
  paymentQuantity: number,
  rewards: Array<{ type: 'gainItem', itemId: 'stone' | 'glow-moss', quantity: number }>,
) {
  const paymentName = paymentItemId === 'ration' ? '口粮' : '野生菌'
  return {
    id,
    description,
    occurrence: { min: occurrence, max: occurrence },
    conditions: [],
    weight: 1,
    choices: [
      {
        id: 'trade',
        label: `递出${paymentName}`,
        conditions: [{ type: 'inventory' as const, itemId: paymentItemId, quantity: paymentQuantity }],
        disabledReason: `缺少 ${paymentQuantity} 份${paymentName}`,
        default: false,
        outcome: {
          type: 'effects' as const,
          effects: [
            { type: 'consumeItem' as const, itemId: paymentItemId, quantity: paymentQuantity },
            ...rewards,
          ],
          message: '无名生物收下食物，把树洞里的东西推到了你面前。',
        },
      },
      {
        id: 'observe',
        label: '留在原地观察',
        conditions: [],
        default: false,
        outcome: { type: 'nothing' as const, message: '你等了一会儿，它仍没有离开树洞。' },
      },
      safeLeave('leave'),
    ],
  }
}
