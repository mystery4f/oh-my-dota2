/**
 * 内置 Dota 术语双向对照表：黑话（萨尔）、物品（黑皇杖）、行话（肉山）各归一类。
 * 只收高置信度的映射 —— 一条错词表比没有词表更糟（glm 把 bkb 译成 bkg 那次，
 * 就是模型不知道 bkb 必须原样保留）。
 *
 * 这份数据现在只喂代码侧：keepVerbatim → 保真守卫的 KEEP_VERBATIM_TOKENS，
 * 全表匹配（glossaryFor）由探针验证边界规则。提示词不再灌全表——6-8 条示例
 * 定风格（见 providers 的 SYSTEM_PROMPTS），术语本身模型认识。
 *
 * keepVerbatim: EN 短缩写两种方向都必须原样保留（bkb / tp / rosh / gg / od…）。
 * 中英混排的聊天行（bkb还差200块钱）靠两侧同时匹配命中。
 */
import type { TranslateDirection } from './ipc'

export type GlossaryKind = 'hero' | 'item' | 'jargon'

export interface GlossaryEntry {
  /** 英文侧：keepVerbatim 词条必须是聊天里真实出现的短缩写（od，不是 Outworld Destroyer）。 */
  en: string
  /** 中文侧：玩家黑话（蓝猫），不是官方译名全称。 */
  zh: string
  kind: GlossaryKind
  keepVerbatim?: boolean
}

export const GLOSSARY: GlossaryEntry[] = [
  // ---- 英雄：CN 黑话 ↔ EN 名 ----
  { en: 'Disruptor', zh: '萨尔', kind: 'hero' },
  { en: 'Razor', zh: '电棍', kind: 'hero' },
  { en: 'Storm Spirit', zh: '蓝猫', kind: 'hero' },
  { en: 'Ember Spirit', zh: '火猫', kind: 'hero' },
  { en: 'Earth Spirit', zh: '土猫', kind: 'hero' },
  { en: 'Drow Ranger', zh: '小黑', kind: 'hero' },
  { en: 'Anti-Mage', zh: '敌法', kind: 'hero' },
  { en: 'Mirana', zh: '白虎', kind: 'hero' },
  { en: 'Medusa', zh: '大娜迦', kind: 'hero' },
  { en: 'Naga Siren', zh: '小娜迦', kind: 'hero' },
  { en: 'Centaur', zh: '人马', kind: 'hero' },
  { en: 'Tidehunter', zh: '潮汐', kind: 'hero' },
  { en: 'Slardar', zh: '大鱼', kind: 'hero' },
  { en: 'Slark', zh: '小鱼', kind: 'hero' },
  { en: 'Ursa', zh: '拍拍', kind: 'hero' },
  { en: 'Outworld Destroyer', zh: '黑鸟', kind: 'hero' },
  { en: 'Ogre Magi', zh: '蓝胖', kind: 'hero' },
  { en: 'Crystal Maiden', zh: '冰女', kind: 'hero' },
  { en: 'Lina', zh: '火女', kind: 'hero' },
  { en: 'Windranger', zh: '风行', kind: 'hero' },
  { en: 'Treant Protector', zh: '大树', kind: 'hero' },
  { en: 'Doom', zh: '末日', kind: 'hero' },
  { en: 'Enchantress', zh: '小鹿', kind: 'hero' },
  { en: 'Puck', zh: '帕克', kind: 'hero' },
  { en: 'Tiny', zh: '小小', kind: 'hero' },
  { en: 'Shadow Fiend', zh: '影魔', kind: 'hero' },
  { en: 'Morphling', zh: '水人', kind: 'hero' },
  { en: 'Spectre', zh: '幽鬼', kind: 'hero' },
  { en: 'Spirit Breaker', zh: '白牛', kind: 'hero' },
  { en: 'Juggernaut', zh: '剑圣', kind: 'hero' },
  // 黑鸟的聊天缩写：两种方向都原样保留 od（zh-en 时 黑鸟 → od）。
  { en: 'od', zh: '黑鸟', kind: 'hero', keepVerbatim: true },
  // ---- 物品：CN 俗名 ↔ EN 名；缩写类 keepVerbatim ----
  { en: 'bkb', zh: '黑皇杖', kind: 'item', keepVerbatim: true },
  { en: 'mkb', zh: '金箍棒', kind: 'item', keepVerbatim: true },
  { en: 'tp', zh: '回城', kind: 'item', keepVerbatim: true },
  { en: "Linken's Sphere", zh: '林肯', kind: 'item' },
  { en: 'Blink Dagger', zh: '跳刀', kind: 'item' },
  { en: 'Force Staff', zh: '推推', kind: 'item' },
  { en: 'Ghost Scepter', zh: '绿杖', kind: 'item' },
  { en: 'Scythe of Vyse', zh: '羊刀', kind: 'item' },
  { en: 'Manta Style', zh: '分身斧', kind: 'item' },
  { en: 'Heart', zh: '龙心', kind: 'item' },
  { en: 'Assault Cuirass', zh: '强袭', kind: 'item' },
  { en: 'Satanic', zh: '撒旦', kind: 'item' },
  { en: 'Divine Rapier', zh: '圣剑', kind: 'item' },
  { en: 'Butterfly', zh: '蝴蝶', kind: 'item' },
  { en: 'Eye of Skadi', zh: '冰眼', kind: 'item' },
  { en: 'Mjollnir', zh: '雷锤', kind: 'item' },
  { en: 'Daedalus', zh: '大炮', kind: 'item' },
  { en: 'Pipe of Insight', zh: '笛子', kind: 'item' },
  { en: 'Mekansm', zh: '梅肯', kind: 'item' },
  { en: 'Glimmer Cape', zh: '微光', kind: 'item' },
  { en: 'Battle Fury', zh: '狂战', kind: 'item' },
  { en: 'Power Treads', zh: '假腿', kind: 'item' },
  { en: 'Shadow Blade', zh: '隐刀', kind: 'item' },
  // ---- 行话：两边都按玩家习惯走 ----
  { en: 'rosh', zh: '肉山', kind: 'jargon', keepVerbatim: true },
  { en: 'aegis', zh: '盾', kind: 'jargon' },
  { en: 'smoke', zh: '开雾', kind: 'jargon' },
  { en: 'ward', zh: '眼', kind: 'jargon' },
  { en: 'deward', zh: '反眼', kind: 'jargon' },
  { en: 'dust', zh: '撒粉', kind: 'jargon' },
  { en: 'buyback', zh: '买活', kind: 'jargon' },
  { en: 'rune', zh: '神符', kind: 'jargon' },
  { en: 'bounty', zh: '赏金符', kind: 'jargon' },
  { en: 'miss', zh: '不见了', kind: 'jargon' },
  { en: 'gank', zh: '抓', kind: 'jargon' },
  { en: 'push', zh: '推', kind: 'jargon' },
  { en: 'def', zh: '守', kind: 'jargon' },
  { en: 'farm', zh: '打钱', kind: 'jargon' },
  { en: 'deny', zh: '反补', kind: 'jargon' },
  { en: 'stack', zh: '囤野', kind: 'jargon' },
  { en: 'pull', zh: '拉野', kind: 'jargon' },
  { en: 'mid', zh: '中单', kind: 'jargon' },
  { en: 'top', zh: '上路', kind: 'jargon' },
  { en: 'bot', zh: '下路', kind: 'jargon' },
  { en: 'jungle', zh: '打野', kind: 'jargon' },
  { en: 'carry', zh: '大哥', kind: 'jargon' },
  { en: 'support', zh: '辅助', kind: 'jargon' },
  { en: 'feed', zh: '送', kind: 'jargon' },
  { en: 'gg', zh: 'gg', kind: 'jargon', keepVerbatim: true },
  { en: 'wp', zh: 'wp', kind: 'jargon', keepVerbatim: true },
  { en: 'ez', zh: 'ez', kind: 'jargon', keepVerbatim: true },
  { en: 'glhf', zh: 'glhf', kind: 'jargon', keepVerbatim: true },
  { en: 'ss', zh: '没了', kind: 'jargon', keepVerbatim: true },
  { en: 're', zh: '回来了', kind: 'jargon', keepVerbatim: true },
  { en: 'b', zh: '撤', kind: 'jargon', keepVerbatim: true }
]

interface PreparedEntry extends GlossaryEntry {
  zhLower: string
  /** EN 侧整词匹配：missing 不得命中 ss，nod 不得命中 od；短语按词边界折叠空白。 */
  enPattern: RegExp
}

function prepare(entry: GlossaryEntry): PreparedEntry {
  const escaped = entry.en
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+')
  return {
    ...entry,
    zhLower: entry.zh.toLowerCase(),
    enPattern: new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`, 'i')
  }
}

const PREPARED: PreparedEntry[] = GLOSSARY.map(prepare)

/**
 * 这行聊天里出现了哪些词条：中文侧按子串、英文侧按整词边界，两侧同时匹配
 * （bkb还差200块钱 这种混排行必须命中 bkb）。探针用例覆盖边界规则；
 * direction 只保留在签名里，匹配本身不分方向。
 * 上限 12 条，防长行把候选撑爆。
 */
export function glossaryFor(text: string, direction: TranslateDirection, cap = 12): GlossaryEntry[] {
  void direction
  const lower = text.toLowerCase()
  const out: GlossaryEntry[] = []
  for (const entry of PREPARED) {
    if (out.length >= cap) break
    if (lower.includes(entry.zhLower) || entry.enPattern.test(lower)) out.push(entry)
  }
  return out
}

/** 保真守卫的 keep token 全表：zh-en 全查这些 token，en-zh/auto-zh 只盯这些。 */
export const JARGON_KEEP_TOKENS: readonly string[] = [
  'gg',
  'wp',
  'ez',
  'glhf',
  'ss',
  'b',
  're',
  'rosh',
  'aegis',
  'smoke',
  'ward',
  'deward',
  'dust',
  'tp',
  'bkb',
  'mkb',
  'od',
  'linken',
  'gank',
  'feed',
  'carry',
  'support',
  'push',
  'def',
  'farm',
  'deny',
  'stack',
  'pull',
  'rune',
  'bounty',
  'buyback',
  'mid',
  'top',
  'bot',
  'jungle'
]

/** 两种方向都必须原样存活的 token：keepVerbatim 词条的 EN 短缩写 ∪ JARGON_KEEP 全表。 */
export const KEEP_VERBATIM_TOKENS: ReadonlySet<string> = (() => {
  const set = new Set<string>(JARGON_KEEP_TOKENS)
  for (const entry of GLOSSARY) {
    if (entry.keepVerbatim !== true) continue
    for (const token of entry.en.toLowerCase().match(/[a-z0-9]+/g) ?? []) set.add(token)
  }
  return set
})()

