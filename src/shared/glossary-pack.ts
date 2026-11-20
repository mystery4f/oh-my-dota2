/**
 * 词表包（glossary pack）：把内置对照表换掉的最小协议。
 *
 * 一个包就是一个 JSON 文件，放在数据目录的 glossary/ 下：
 *   { "name": "东南亚服常用词", "entries": [ { "en": "Anti-Mage", "zh": "敌法", "kind": "hero" } ] }
 * 名字即文件名（<name>.json），换词表不用重新打包 —— 放文件、在面板里点一下。
 *
 * 坏包一律当没装：字段不合法就整包拒绝并回退内置那份，因为「一条错词表比没有词表更糟」
 * （见 dota-glossary.ts 的文件头）。拒绝原因原文写进 status.error，面板据此画警告，
 * 不静默吞掉 —— 用户放了一份文件却什么也没发生，是最难查的失败。
 */
import { BUNDLED_GLOSSARY, type GlossaryEntry, type GlossaryKind } from './dota-glossary'

/** 包名要显示在面板一行里，也参与文件名，所以有上限；条目上限防手滑塞几十兆。 */
export const GLOSSARY_PACK_NAME_MAX = 24
export const GLOSSARY_PACK_ENTRIES_MAX = 600
export const GLOSSARY_PACK_FILE = 'glossary-pack.json'
export const BUNDLED_GLOSSARY_NAME = '内置'

const KINDS: readonly GlossaryKind[] = ['hero', 'item', 'jargon']

export interface GlossaryPackFile {
  name: string
  entries: GlossaryEntry[]
}

export interface GlossaryPackStatus {
  /** 现役词表名：内置表时是「内置」。 */
  name: string
  /** pack：数据目录里的词表包；bundled：随包发布的那份。 */
  source: 'pack' | 'bundled'
  entries: number
  /** 坏包的原因（已经回退内置，但原因要留给面板）。 */
  error: string | null
  /** 数据目录里的文件名（没有包时为 null）。 */
  file: string | null
  /** 数据目录里找到的所有包名，面板据此列选项。 */
  available: string[]
}

export type GlossaryPackParse = { ok: true; pack: GlossaryPackFile } | { ok: false; error: string }

function entryProblem(raw: unknown, index: number): string | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return `第 ${index + 1} 条不是对象`
  const row = raw as Record<string, unknown>
  const en = typeof row.en === 'string' ? row.en.trim() : ''
  const zh = typeof row.zh === 'string' ? row.zh.trim() : ''
  if (!en) return `第 ${index + 1} 条缺 en`
  if (en.length > 64) return `第 ${index + 1} 条的 en 太长（超 64 字符）`
  if (!zh) return `第 ${index + 1} 条缺 zh`
  if (zh.length > 32) return `第 ${index + 1} 条的 zh 太长（超 32 字符）`
  if (typeof row.kind !== 'string' || !KINDS.includes(row.kind as GlossaryKind))
    return `第 ${index + 1} 条的 kind 只能是 hero / item / jargon`
  if (row.keepVerbatim !== undefined && typeof row.keepVerbatim !== 'boolean')
    return `第 ${index + 1} 条的 keepVerbatim 只能是布尔`
  return null
}

/**
 * 校验一个包：形状、每一条的字段、条数上限，以及 en 去重（同一条 en 只留第一次出现的，
 * 因为对照表是按 EN 整词匹配的，重复条目只会让同一条消息命中两遍）。
 */
export function parseGlossaryPack(raw: unknown): GlossaryPackParse {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    return { ok: false, error: '词表包必须是一个对象：{"name": "...", "entries": [...]}' }
  const pack = raw as Record<string, unknown>
  const name = typeof pack.name === 'string' ? pack.name.trim() : ''
  if (!name) return { ok: false, error: '词表包缺少 name' }
  if (name.length > GLOSSARY_PACK_NAME_MAX) return { ok: false, error: `词表包名太长（超 ${GLOSSARY_PACK_NAME_MAX} 字）` }
  if (!Array.isArray(pack.entries)) return { ok: false, error: '词表包缺少 entries 数组' }
  if (pack.entries.length === 0) return { ok: false, error: '词表包的 entries 是空的' }
  if (pack.entries.length > GLOSSARY_PACK_ENTRIES_MAX)
    return { ok: false, error: `词表包条目太多（超 ${GLOSSARY_PACK_ENTRIES_MAX} 条）` }
  const seen = new Set<string>()
  const entries: GlossaryEntry[] = []
  for (let index = 0; index < pack.entries.length; index++) {
    const problem = entryProblem(pack.entries[index], index)
    if (problem) return { ok: false, error: problem }
    const row = pack.entries[index] as Record<string, unknown>
    const en = String(row.en).trim()
    const key = en.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    entries.push({
      en,
      zh: String(row.zh).trim(),
      kind: row.kind as GlossaryKind,
      ...(row.keepVerbatim === true ? { keepVerbatim: true as const } : {})
    })
  }
  return { ok: true, pack: { name, entries } }
}

export function bundledGlossaryStatus(
  error: string | null = null,
  available: string[] = [],
  file: string | null = null
): GlossaryPackStatus {
  return {
    name: BUNDLED_GLOSSARY_NAME,
    source: 'bundled',
    entries: BUNDLED_GLOSSARY.length,
    error,
    file,
    available
  }
}

export function glossaryStatusOf(
  pack: GlossaryPackFile,
  file: string | null = null,
  available: string[] = []
): GlossaryPackStatus {
  return { name: pack.name, source: 'pack', entries: pack.entries.length, error: null, file, available }
}

/** 面板那一行的正文：现役哪份、多少条；坏包把原因接在后面，不另起一行。 */
export function glossaryPackLine(status: GlossaryPackStatus): string {
  const head =
    status.source === 'pack'
      ? `现役「${status.name}」· ${status.entries} 条`
      : `${BUNDLED_GLOSSARY_NAME}词表 · ${status.entries} 条`
  if (status.error) return `${head} · ${status.error}，已回退内置`
  if (status.available.length === 0) return `${head} · 数据目录 glossary/ 里还没有词表包`
  return `${head} · 可选 ${status.available.length} 个包`
}
