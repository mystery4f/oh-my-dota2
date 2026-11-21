/**
 * 逐人朗读开关（#93）：哪些人不念。
 *
 * 为什么名单要按「身份两路」存：GSI 对同一个人可能给英雄短名（`nevermore`），也可能只给
 * 座位标签（`玩家2`）——真对局里 `allplayers` 常常一帧都没有。所以静音表同时收英雄短名与
 * 昵称/座位名，命中任一路就跳过。
 *
 * 判据是纯函数、不碰设置也不碰 IPC：探针直接喂条目断言「被静音的人一句都不念，其他人照念」。
 */
export interface SpeakIdentity {
  /** 英雄短名（`nevermore`），GSI 给了才有。 */
  hero: string | null
  /** 昵称或座位标签（`玩家2`），从展示串的 `[昵称]` 段里取。 */
  name: string | null
}

export interface MuteTable {
  /** 静音的英雄短名（小写）。 */
  heroes: readonly string[]
  /** 静音的昵称 / 座位名（小写）。 */
  names: readonly string[]
}

export const EMPTY_MUTE_TABLE: MuteTable = { heroes: [], names: [] }

/**
 * 从展示串里取昵称：格式是 `[队友] [昵称] ⚔ 正文`（`@shared/ipc` 里 CaptureEntry.original 的注释）。
 * 取不到就返回 null——宁可「念出来」，也不要因为解析不到而悄悄把某个人永久静音。
 */
export function identityOf(input: { speaker?: string; original: string }): SpeakIdentity {
  const hero = input.speaker?.trim() ? input.speaker.trim().toLowerCase() : null
  const bracket = /\[([^\]\n]{1,24})\]/u.exec(input.original)
  const name = bracket && bracket[1] ? bracket[1].trim().toLowerCase() : null
  return { hero, name }
}

/** 名单归一：去空、去重、小写。手写的名单里大小写与空格是最常见的「设了没生效」。 */
export function normalizeMuteList(raw: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const one of raw) {
    const clean = one.trim().toLowerCase()
    if (clean === '' || seen.has(clean)) continue
    seen.add(clean)
    out.push(clean)
  }
  return out
}

export function muteTableOf(input: { muteHeroes: readonly string[]; muteNames: readonly string[] }): MuteTable {
  return { heroes: normalizeMuteList(input.muteHeroes), names: normalizeMuteList(input.muteNames) }
}

/** 这个人是否被静音。两路都不认识这个人时一律「不静音」。 */
export function isMuted(table: MuteTable, identity: SpeakIdentity): boolean {
  if (identity.hero !== null && table.heroes.includes(identity.hero)) return true
  if (identity.name !== null && table.names.includes(identity.name)) return true
  return false
}

/**
 * 面板那一行：静音了几个人、名单是什么。
 *
 * 两路名单是去重后的并集：面板只有一个输入框（一个词可能既是昵称又是英雄短名），
 * 所以同一个词可能同时出现在两路里——显示的「几个」必须是去重后的数，不然人数会骗人。
 */
export function muteLine(table: MuteTable): string {
  const parts = normalizeMuteList([...table.names, ...table.heroes])
  if (parts.length === 0) return '没有静音任何人：所有人都念'
  return `静音 ${parts.length} 个：${parts.join('、')}`
}

/** 名单输入框的解析（逗号/顿号/空白都当分隔），与归一同一套规则。 */
export function parseMuteList(raw: string): string[] {
  return normalizeMuteList(raw.split(/[,，、;；\s]+/u))
}

/** 名单输入框的回显：按原有顺序连起来，方便人接着改。 */
export function formatMuteList(list: readonly string[]): string {
  return normalizeMuteList(list).join('、')
}