/**
 * 复盘星标（#118）：对局里标一句，复盘时它排在最前面。
 *
 * 这里只放判定与文案，读写落在 `src/main/services/session/replay-stars.ts`。
 *
 * 三条口径写在类型里而不是注释里：
 * - 星标**必须带 matchid**（取 `liveMatchId()`，拿不到写显式 null）。没有归属的星标
 *   属于「不知道是哪一局」，复盘时按局读就不会把它算进任何一局。
 * - 同一行（`entryId`）重复标只算一次，取最后一次的时间与备注——改主意不该变成两条。
 * - 没标过的局读出来是空的，不是「全部」：`starsOf()` 只认精确匹配。
 */

/** 一条星标。`matchid` 为 null = 当时没有活着的 GSI 帧，归属不明。 */
export interface ReplayStar {
  at: string
  matchid: string | null
  entryId: string
  source: string
  translation: string
  note: string
}

/** 记一条星标需要的全部输入。 */
export interface ReplayStarInput {
  at: string
  matchid: string | null
  entry: { entryId: string; source: string; translation: string }
  note?: string
}

/** 备注上限：这是一句话的备注，不是评论区。 */
export const REPLAY_STAR_NOTE_MAX = 120

/** 一局的星标汇总。`total` 是这一局标了几条，`matches` 是全部记录里出现过几局。 */
export interface ReplayStarSummary {
  matchid: string | null
  total: number
  matches: number
  newest: string | null
  stars: ReplayStar[]
}

/** 去重键：同一行只留一条。 */
export function starKey(entryId: string): string {
  return entryId.trim()
}

/**
 * 从浮层的一行造一条星标。原文或译文为空就不造——空样本进了复盘只会让人困惑。
 */
export function buildStar(input: ReplayStarInput): ReplayStar | null {
  const key = starKey(input.entry.entryId)
  const source = input.entry.source.trim()
  const translation = input.entry.translation.trim()
  if (key === '' || source === '' || translation === '') return null
  const note = (input.note ?? '').trim().slice(0, REPLAY_STAR_NOTE_MAX)
  return {
    at: input.at,
    matchid: input.matchid === null || input.matchid.trim() === '' ? null : input.matchid.trim(),
    entryId: key,
    source,
    translation,
    note
  }
}

/**
 * 按行去重，后写的覆盖先写的（保留第一次出现的位置，顺序仍然按时间读得顺）。
 */
export function dedupeStars(stars: readonly ReplayStar[]): ReplayStar[] {
  const seen = new Map<string, ReplayStar>()
  for (const star of stars) {
    const key = starKey(star.entryId)
    if (key === '') continue
    seen.set(key, star)
  }
  return [...seen.values()]
}

/**
 * 取某一局的星标。`matchid` 传 null 时只返回**归属不明**的那些，
 * 绝不「返回全部」——没标过的局必须读成空，否则复盘会把别人的星标算进来。
 */
export function starsOf(stars: readonly ReplayStar[], matchid: string | null): ReplayStar[] {
  const wanted = matchid === null || matchid.trim() === '' ? null : matchid.trim()
  return dedupeStars(stars).filter((star) => star.matchid === wanted)
}

/** 汇总一局：条数、全量里出现过几局、最近一条时间。 */
export function summarizeStars(stars: readonly ReplayStar[], matchid: string | null): ReplayStarSummary {
  const unique = dedupeStars(stars)
  const mine = starsOf(unique, matchid)
  let newest: string | null = null
  for (const star of mine) {
    if (newest === null || star.at > newest) newest = star.at
  }
  const matches = new Set<string>()
  for (const star of unique) {
    if (star.matchid !== null) matches.add(star.matchid)
  }
  return { matchid, total: mine.length, matches: matches.size, newest, stars: mine }
}

/** 一条星标的短描述：`12:31:07 · 标了 1 句`。 */
export function starLine(star: ReplayStar | null): string {
  if (star === null) return '这一局还没标过句子'
  const time = star.at.length >= 19 ? star.at.slice(11, 19) : star.at
  return `${time} · 标了 1 句${star.note === '' ? '' : `（${star.note}）`}`
}

/** 按热键之后的回执。热键不许静默：标不上也要说清楚为什么。 */
export function starFeedback(star: ReplayStar | null): string {
  if (star === null) return '没标上：浮层上还没有一句翻好的话（先等一句译文出来再按）'
  if (star.matchid === null) return '已标记（没有活着的对局帧，这条算「归属不明」）'
  return `已标记：${star.matchid}`
}
