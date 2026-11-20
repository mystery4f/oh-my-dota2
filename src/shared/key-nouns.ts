/**
 * 关键名词核对：源文里点名的英雄/物品，译文里还认不认得出。
 *
 * 老板的规矩是「翻译前先拿原文对一次词表」：`keyNounsOf` 在翻译之前把这一行里的
 * 全名抽成清单（英文侧整词边界、中文侧子串，与 `glossaryFor` 同一套匹配规则），
 * 翻译完 `flagKeyNouns` 只核对这份清单，不再回头扫源文——别让译文的用词反过来
 * 决定该找什么。
 *
 * 核对结果只是「问一句」：`flagKeyNouns` 把传进来的译文**原样**返回，丢掉的名词
 * 单独列出来，浮层打一个「？」给人类看。这里没有任何自动改写，译文的去留由人定。
 *
 * 不在本缝范围：缩写保真（bkb → bkg）归 `translate-fidelity.latinTokenViolations`；
 * 术语类词条（mid / top / push）是普通英文词，点名不算「关键名词」，不在这里判。
 */
import { GLOSSARY, type GlossaryKind } from './dota-glossary'
import type { TranslateDirection } from './ipc'

export interface KeyNoun {
  /** 英文侧全名，如 `Blink Dagger`；译文保留原文时按整词比对。 */
  en: string
  /** 中文侧名字，如 `跳刀`；给人类看的也是它。 */
  zh: string
  kind: GlossaryKind
}

/** 核对结果：`keyNouns` 是丢掉的中文名（同一名词只列一次），`text` 是原样的译文。 */
export interface KeyNounCheck {
  text: string
  keyNouns: string[]
}

/** 英文侧整词模式：missing 不得命中 ss，tiny 不得命中 tinyhouse。 */
function enPatternOf(en: string): RegExp {
  const escaped = en
    .toLowerCase()
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\s+/g, '\\s+')
  return new RegExp(`(?:^|[^a-z0-9])${escaped}(?:[^a-z0-9]|$)`)
}

/** 词表里能当「关键名词」点名的条目：英雄与物品（含 keepVerbatim 的短名，如 od、bkb）。 */
const NAMED: { entry: KeyNoun; pattern: RegExp }[] = GLOSSARY.filter((entry) => entry.kind !== 'jargon').map(
  (entry) => ({
    entry: { en: entry.en, zh: entry.zh, kind: entry.kind },
    pattern: enPatternOf(entry.en)
  })
)

/** 翻译前的那一次比对：这一行点名的英雄/物品清单（同一词条只出现一次）。 */
export function keyNounsOf(source: string, direction: TranslateDirection): KeyNoun[] {
  const lower = source.toLowerCase()
  const byZh = direction === 'zh-en'
  const out: KeyNoun[] = []
  for (const entry of NAMED) {
    if (byZh ? source.includes(entry.entry.zh) : entry.pattern.test(lower)) out.push(entry.entry)
  }
  return out
}

/**
 * 翻译后的核对：只认传进来的清单，译文一个字都不改地返回，列出丢掉的名词。
 * 名词活下来的两种形态都算没丢——中文名（跳刀）或者英文原名（Blink Dagger / blink）。
 */
export function flagKeyNouns(nouns: KeyNoun[], target: string): KeyNounCheck {
  const lower = target.toLowerCase()
  const keyNouns: string[] = []
  for (const noun of nouns) {
    if (lower.includes(noun.zh.toLowerCase())) continue
    if (enPatternOf(noun.en).test(lower)) continue
    keyNouns.push(noun.zh)
  }
  return { text: target, keyNouns }
}
