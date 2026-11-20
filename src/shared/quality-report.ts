/**
 * 周度质量卡的口径：守卫抓了几次 + 记账本白拿了几次，两段数，没有第三段。
 *
 * **没有「漏检率」「准确率」**：守卫只在判出违例时才写行，没抓到的那次代码里根本不知道，
 * 拿违例数除以翻译总数算出来的「漏检率」是编的——分母不存在。所以这里只出计数，
 * 一句话里也不许出现「率」字。缓存那段有分母（白拿 + 现翻），说的是「命中占比」，
 * 不是「未命中率」：用户关心的是省了多少次模型调用。
 *
 * 纯类型 + 纯函数：读文件在主进程（`services/session/quality-report.ts`），
 * 探针直接把两份 jsonl 的文本喂进来断言。
 */
import { summarizeGuardLog, type GuardTally } from './guard-telemetry'

/** 守卫那一段：拦下几次、救回几次、退回原文几次，外加最常见的违规 token。 */
export interface QualityGuard {
  caught: number
  recovered: number
  gaveUp: number
  tokens: { token: string; count: number }[]
}

/**
 * 记账本那一段。`pairs` / `lifetimeHits` / `hitRatio` 是库里的累计值（跨进程可信）；
 * `sessionHits` / `sessionMisses` / `sessionRatio` 是「这一次运行」的计数，从最新一行的
 * `sessionHits`/`sessionMisses` 直接读——两套口径分开命名，不混成一个数。
 */
export interface QualityCache {
  /** 日志里成功解析出的快照行数；0 表示这次运行还没拍过快照。 */
  snapshots: number
  pairs: number
  lifetimeHits: number
  hitRatio: number
  sessionHits: number
  sessionMisses: number
  sessionRatio: number
}

/** 面板要的全部数字：两段，外加空日志时也成立（全 0，不是 null）。 */
export interface QualityReport {
  guard: QualityGuard
  cache: QualityCache
}

const EMPTY_CACHE: QualityCache = {
  snapshots: 0,
  pairs: 0,
  lifetimeHits: 0,
  hitRatio: 0,
  sessionHits: 0,
  sessionMisses: 0,
  sessionRatio: 0
}

/** 记账本快照的一行（`snapshotTranslationStats()` 写的），只留卡片用得到的字段。 */
export interface CacheSnapshot {
  pairs: number
  lifetimeHits: number
  hitRatio: number
  sessionHits: number
  sessionMisses: number
}

const finite = (value: unknown, fallback = 0): number =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback

/**
 * 一行 jsonl 还原成快照；不是完整快照就返回 null。
 *
 * 快照每 60 秒拍一次、进程被 kill 时最后一行常常是半截，统计直接从文件读，
 * 脏行必须在入口丢掉——不能一个 JSON.parse 异常把整张卡带塌。
 */
export function parseCacheSnapshot(line: string): CacheSnapshot | null {
  const trimmed = line.trim()
  if (trimmed.length === 0) return null
  let raw: unknown
  try {
    raw = JSON.parse(trimmed)
  } catch {
    return null
  }
  if (typeof raw !== 'object' || raw === null) return null
  const row = raw as Record<string, unknown>
  if (typeof row.at !== 'string' || row.at.length === 0) return null
  // `pairs` 与 `lifetimeHits` 是必有的累计列；只有 session 计数缺了才给 0。
  if (typeof row.pairs !== 'number' || typeof row.lifetimeHits !== 'number') return null
  return {
    pairs: finite(row.pairs),
    lifetimeHits: finite(row.lifetimeHits),
    hitRatio: finite(row.hitRatio),
    sessionHits: finite(row.sessionHits),
    sessionMisses: finite(row.sessionMisses)
  }
}

/** 命中占比：分母是「白拿 + 现翻」，两边都是 0 时给 0。 */
function share(hits: number, misses: number): number {
  const total = hits + misses
  return total === 0 ? 0 : Math.round((hits / total) * 1000) / 1000
}

/** 从快照行算记账本那一段：累计值取最新一行，本次运行的数也取最新一行。 */
export function summarizeCacheSnapshots(rows: readonly CacheSnapshot[]): QualityCache {
  if (rows.length === 0) return { ...EMPTY_CACHE }
  const last = rows[rows.length - 1]
  return {
    snapshots: rows.length,
    pairs: last.pairs,
    lifetimeHits: last.lifetimeHits,
    hitRatio: last.hitRatio,
    sessionHits: last.sessionHits,
    sessionMisses: last.sessionMisses,
    sessionRatio: share(last.sessionHits, last.sessionMisses)
  }
}

/** 守卫那一段：直接复用 `summarizeGuardLog` 的口径，只把名字换成卡片用的说法。 */
export function guardQualityOf(tally: GuardTally): QualityGuard {
  return {
    caught: tally.blocked,
    recovered: tally.recovered,
    gaveUp: tally.gaveUp,
    tokens: tally.tokens
  }
}

/** 两份 jsonl 的文本进，一张卡的数出。空文本 = 全 0，不抛、不返回 null。 */
export function qualityReportOf(input: { guardText?: string; cacheText?: string }): QualityReport {
  const guard = guardQualityOf(summarizeGuardLog(input.guardText ?? ''))
  const rows: CacheSnapshot[] = []
  for (const line of (input.cacheText ?? '').split('\n')) {
    const row = parseCacheSnapshot(line)
    if (row !== null) rows.push(row)
  }
  return { guard, cache: summarizeCacheSnapshots(rows) }
}

/**
 * 守卫那一行的人话。任何情况下都不带百分号：没有分母的数写出来就是错。
 * 全 0 时也照实写 0（「空日志显示 0 而不是报错」）。
 */
export function guardLine(guard: QualityGuard): string {
  return `拦下 ${guard.caught} 次 · 救回 ${guard.recovered} 次 · 退回原文 ${guard.gaveUp} 次`
}

/** 记账本那一行的人话：本次运行白拿几次、现翻几次，占比是多少。 */
export function cacheLine(cache: QualityCache): string {
  const percent = Math.round(cache.sessionRatio * 100)
  return `本次运行白拿 ${cache.sessionHits} 次 · 现翻 ${cache.sessionMisses} 次 · 命中占比 ${percent}%`
}

/** 卡片的第三行小字：规约与数据来源都写在这里，面板不另编话。 */
export function qualityFootnote(cache: QualityCache): string {
  return `记账本累计 ${cache.pairs} 对 · 累计白拿 ${cache.lifetimeHits} 次 · 过去 ${cache.snapshots} 次快照；守卫只记抓到的，不估没抓到的`
}
