/**
 * 快捷短语的分组与变量（#117）。
 *
 * 现状是 `settings.quickPhrases` 一个平铺数组：话一多就翻不到，且每句话都得自己拼「谁、什么时候」。
 * 这里只做两件纯函数的事——**分组**与**变量替换**——不含任何 UI。
 *
 * 变量写作 `{hero}` `{time}` `{matchid}`；认不出来的占位符**原样留着**，不猜、也不删：
 * 用户打错字时看到 `{heor}` 才会发现「该写的是 hero」，静默吞掉等于让他永远不知道。
 */

export interface QuickPhraseGroup {
  name: string
  phrases: string[]
}

/** 变量表：键就是短语里的占位符。 */
export interface PhraseVars {
  hero: string | null
  time: string | null
  matchid: string | null
}

export const PHRASE_VARIABLES = ['hero', 'time', 'matchid'] as const

export const EMPTY_PHRASE_VARS: PhraseVars = { hero: null, time: null, matchid: null }

const PLACEHOLDER = /\{([a-z]+)\}/g

/** 把 `{hero}` 这类占位符换成当前值；拿不到的变量原样保留（并进 `missing`）。 */
export function renderPhrase(text: string, vars: PhraseVars): { text: string; missing: string[] } {
  const missing: string[] = []
  const rendered = text.replace(PLACEHOLDER, (whole, name: string) => {
    if (name !== 'hero' && name !== 'time' && name !== 'matchid') return whole
    const value = vars[name]
    if (value === null || value.trim() === '') {
      if (!missing.includes(name)) missing.push(name)
      return whole
    }
    return value
  })
  return { text: rendered, missing }
}

/** 一句里用到的变量（给编辑器做提示，不判断是否有值）。 */
export function phraseVariables(text: string): string[] {
  const found: string[] = []
  for (const match of text.matchAll(PLACEHOLDER)) {
    const name = match[1]
    if (!found.includes(name)) found.push(name)
  }
  return found
}

/**
 * 规范化分组：名字 trim、丢空短语、**丢掉没有短语的组**。
 * 空组显示出来是一个只有一个标题的框，人第一反应是「这里能填吗」，所以直接不显示（票面验收第二条）。
 */
export function visibleGroups(groups: readonly QuickPhraseGroup[]): QuickPhraseGroup[] {
  const result: QuickPhraseGroup[] = []
  for (const group of groups) {
    const name = group.name.trim()
    const phrases = group.phrases.map((phrase) => phrase.trim()).filter((phrase) => phrase !== '')
    if (name === '' || phrases.length === 0) continue
    result.push({ name, phrases })
  }
  return result
}

/** 平铺（含未分组的老短语）保持原顺序：老用户在平铺列表里改顺序，不该被分组打乱。 */
export function flattenGroups(loose: readonly string[], groups: readonly QuickPhraseGroup[]): string[] {
  const flat = loose.map((phrase) => phrase.trim()).filter((phrase) => phrase !== '')
  for (const group of visibleGroups(groups)) flat.push(...group.phrases)
  return flat
}

/** 面板/浮层要显示的那份：渲染过变量，缺变量的位置原样留着。 */
export interface RenderedPhraseGroup {
  name: string
  phrases: string[]
  missing: string[]
}

export function renderGroups(
  loose: readonly string[],
  groups: readonly QuickPhraseGroup[],
  vars: PhraseVars
): RenderedPhraseGroup[] {
  const missing: string[] = []
  const out: RenderedPhraseGroup[] = []
  const loosePhrases = loose.map((phrase) => phrase.trim()).filter((phrase) => phrase !== '')
  if (loosePhrases.length > 0) {
    const rendered = loosePhrases.map((phrase) => {
      const one = renderPhrase(phrase, vars)
      for (const name of one.missing) if (!missing.includes(name)) missing.push(name)
      return one.text
    })
    out.push({ name: UNGROUPED, phrases: rendered, missing: [] })
  }
  for (const group of visibleGroups(groups)) {
    const rendered = group.phrases.map((phrase) => {
      const one = renderPhrase(phrase, vars)
      for (const name of one.missing) if (!missing.includes(name)) missing.push(name)
      return one.text
    })
    out.push({ name: group.name, phrases: rendered, missing: [] })
  }
  return out.map((group) => ({ ...group, missing }))
}

/** 未分组那份的标签：面板里得有个名字，否则那一坨不知道是什么。 */
export const UNGROUPED = '未分组'

/** 一行摘要：`3 组 · 12 句 · 缺变量 hero`。 */
export function phrasesLine(groups: readonly RenderedPhraseGroup[]): string {
  if (groups.length === 0) return '还没有快捷短语'
  const count = groups.reduce((sum, group) => sum + group.phrases.length, 0)
  const missing = groups[0]?.missing ?? []
  const tail = missing.length === 0 ? '' : ` · 缺变量 ${missing.join(' / ')}`
  return `${groups.length} 组 · ${count} 句${tail}`
}

/** 游戏时间秒数 → `12:34`；拿不到就说「未知」，不写 00:00（那会被当成刚开局）。 */
export function formatGameTime(seconds: number | null): string | null {
  if (seconds === null || !Number.isFinite(seconds)) return null
  const total = Math.max(0, Math.floor(seconds))
  const minutes = Math.floor(total / 60)
  const rest = total % 60
  return `${minutes}:${String(rest).padStart(2, '0')}`
}
