import { DatabaseSync } from 'node:sqlite'
import { existsSync, mkdirSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import { normalizeLine } from '../capture/chat-lines'

/**
 * 翻译记账本：一次翻译同时记下「你好 ↔ hello」这对，两个方向都能直接命中。
 * 用户要的就是这个——自己说过「你好」、模型译成 hello，之后队里谁说 hello，
 * 就直接显示「你好」，一个 token 都不用再花。
 *
 * 落盘 sqlite，重启后仍然命中；不设 TTL（v2 的设计决策 Q3：永不过期）。
 * 键带 provider（换模型译风不同，互不串味）；带 tone（同一句话换个语气该重翻）。
 * 上限 20k 对，超了按最近命中淘汰。
 *
 * 除了译文，每行还预先记下做词频统计要用的字段：首次方向、首次来源、
 * 字符数、粗略词数。这些现在没人读，但历史数据只有「当时写了」才有——
 * 事后补不回来，所以先落盘。
 */
const MAX_PAIRS = 20_000
const FILE_NAME = 'translate-cache.sqlite'

/** 这一对最初是谁问出来的：抓屏、回复框、试用页、预热。 */
export type TranslationOrigin = 'capture' | 'reply' | 'try' | 'warm' | 'probe'

const REQUIRED_COLUMNS = [
  'a_raw',
  'direction',
  'origin',
  'a_len',
  'b_len',
  'a_words',
  'b_words',
  'last_origin'
]

let db: DatabaseSync | null = null
let dbFailed = false
const memory = new Map<string, MemoryPair>()
const stats = { hits: 0, misses: 0, writes: 0, evicted: 0 }

interface MemoryPair {
  tone: string
  a: string
  b: string
  direction: string
  origin: TranslationOrigin
  hits: number
}

/** 目标语言是不是中文：决定「反过来查」时能接受哪一侧。 */
function wantsChinese(direction: string): boolean {
  return direction !== 'zh-en'
}

function hasHan(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text)
}

/**
 * 粗略词数：汉字逐字计，拉丁部分按空格切。
 * 只为了让词频统计能按「这句多长」加权，不需要分词级精度。
 */
export function roughWordCount(text: string): number {
  const han = text.match(/[\u3400-\u9fff]/g)?.length ?? 0
  const latin = text.replace(/[\u3400-\u9fff]/g, ' ').trim()
  const words = latin.length === 0 ? 0 : latin.split(/\s+/).filter(Boolean).length
  return han + words
}

export function translationCachePath(): string {
  return join(app.getPath('userData'), FILE_NAME)
}

/**
 * 把坏掉的库挪走，下次 open() 重建一个空的。
 *
 * 为什么需要它：sqlite 的索引一旦损坏（断电、两个进程同时写、杀进程杀在提交中间），
 * 每次写都会抛 "database disk image is malformed"，而缓存层是「尽力而为」的——
 * 一直失败的缓存等于没有缓存，还会把日志刷满。挪走比原地修更划算：内容是可重建的翻译记忆。
 */
function healCorruptDatabase(reason: string): void {
  const file = translationCachePath()
  try {
    if (db !== null) db.close()
  } catch {
    // 关不掉也要继续挪文件
  }
  db = null
  dbFailed = false
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  for (const path of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      if (existsSync(path)) renameSync(path, `${path}.corrupt-${stamp}`)
    } catch {
      // 挪不动就让 open() 继续报错，至少不在这里死循环
    }
  }
  console.log('TRANSLATE_CACHE_QUARANTINED', reason)
}

function looksCorrupt(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err)
  return /malformed|not a database|disk image is malformed|database corruption/i.test(message)
}

function open(): DatabaseSync | null {
  if (db !== null) return db
  if (dbFailed) return null
  try {
    const file = translationCachePath()
    mkdirSync(dirname(file), { recursive: true })
    const next = new DatabaseSync(file)
    next.exec('PRAGMA journal_mode = WAL')
    // 早期版本按方向单边存，语义换成双向账本后那张表没用了。
    next.exec('DROP TABLE IF EXISTS translation')
    // 表结构演进过（补原文/统计字段），老账本丢掉重来——它是缓存，不是账本数据。
    const existing = next
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pair'")
      .get() as { name: string } | undefined
    if (existing !== undefined) {
      const columns = (next.prepare('PRAGMA table_info(pair)').all() as { name: string }[]).map(
        (column) => column.name
      )
      if (!REQUIRED_COLUMNS.every((name) => columns.includes(name))) next.exec('DROP TABLE pair')
    }
    next.exec(`
      CREATE TABLE IF NOT EXISTS pair (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        provider TEXT NOT NULL,
        tone TEXT NOT NULL,
        a TEXT NOT NULL,
        a_raw TEXT NOT NULL,
        b TEXT NOT NULL,
        a_han INTEGER NOT NULL,
        direction TEXT NOT NULL,
        origin TEXT NOT NULL,
        a_len INTEGER NOT NULL,
        b_len INTEGER NOT NULL,
        a_words INTEGER NOT NULL,
        b_words INTEGER NOT NULL,
        hits INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        last_hit_at INTEGER NOT NULL,
        last_origin TEXT NOT NULL,
        UNIQUE(provider, tone, a)
      )
    `)
    next.exec('CREATE INDEX IF NOT EXISTS idx_pair_b ON pair(provider, tone, b)')
    next.exec('CREATE INDEX IF NOT EXISTS idx_pair_hits ON pair(hits DESC)')
    // 索引损坏时 prepare/run 都会抛，但 SELECT 仍能读——所以必须在打开时查一次，
    // 否则症状是「读得到旧行、写不进新行」，看起来像词库凭空停止增长。
    const check = next.prepare('PRAGMA quick_check(1)').get() as { quick_check?: string } | undefined
    if (check !== undefined && check.quick_check !== 'ok') {
      try {
        next.close()
      } catch {
        // 已经坏了，关闭失败无所谓
      }
      healCorruptDatabase(`quick_check: ${check.quick_check}`)
      return open()
    }
    db = next
    return db
  } catch (err) {
    // 缓存坏了不能拖垮翻译：退回进程内 Map，功能降级但结果照出。
    dbFailed = true
    console.log('TRANSLATE_CACHE_OPEN_FAILED', err instanceof Error ? err.message : String(err))
    return null
  }
}

/** 关掉句柄，只为探针验证「落盘后重新打开还在」。 */
export function closeTranslationCache(): void {
  if (db === null) return
  try {
    db.close()
  } catch {
    // 关不掉也不影响下一次打开
  }
  db = null
}

function pairKey(provider: string, tone: string, text: string): string {
  return `${provider}|${tone}|${normalizeLine(text)}`
}

export interface LookupHit {
  value: string
  /** 命中的那一行存的语气。与请求语气不同，说明是跨语气兜底命中的。 */
  tone: string
}

/**
 * 带语气信息的查询：先按目标语气找，找不到再去别的语气里找同一句源文。
 * crossTone 关掉时只有「正查同语气 + 反查任意语气」。
 */
export function lookupTranslation(
  text: string,
  direction: string,
  provider: string,
  tone = '',
  origin: TranslationOrigin = 'capture',
  crossTone = true
): LookupHit | null {
  const wantHan = wantsChinese(direction)
  const source = normalizeLine(text)
  const handle = open()

  if (handle === null) {
    const forward = memory.get(pairKey(provider, tone, text))
    if (forward !== undefined && hasHan(forward.b) === wantHan) {
      forward.hits += 1
      stats.hits += 1
      return { value: forward.b, tone }
    }
    if (crossTone) {
      for (const [key, pair] of memory) {
        if (!key.startsWith(`${provider}|`) || pair.a !== source) continue
        if (hasHan(pair.b) !== wantHan) continue
        pair.hits += 1
        stats.hits += 1
        return { value: pair.b, tone: pair.tone }
      }
    }
    for (const [key, pair] of memory) {
      if (!key.startsWith(`${provider}|`)) continue
      if (normalizeLine(pair.b) === source && hasHan(pair.a) === wantHan) {
        pair.hits += 1
        stats.hits += 1
        return { value: pair.a, tone: pair.tone }
      }
    }
    stats.misses += 1
    return null
  }

  try {
    const forward = handle
      .prepare('SELECT b, a_han FROM pair WHERE provider = ? AND tone = ? AND a = ?')
      .get(provider, tone, source) as { b: string; a_han: number } | undefined
    if (forward !== undefined && hasHan(forward.b) === wantHan) {
      handle
        .prepare(
          'UPDATE pair SET hits = hits + 1, last_hit_at = ?, last_origin = ? WHERE provider = ? AND tone = ? AND a = ?'
        )
        .run(Date.now(), origin, provider, tone, source)
      stats.hits += 1
      return { value: forward.b, tone }
    }
    // 跨语气：这句话当源文存在，只是当初用的语气不同。
    if (crossTone) {
      const other = handle
        .prepare(
          'SELECT id, b, a_han, tone FROM pair WHERE provider = ? AND a = ? ORDER BY hits DESC LIMIT 1'
        )
        .get(provider, source) as { id: number; b: string; a_han: number; tone: string } | undefined
      if (other !== undefined && hasHan(other.b) === wantHan) {
        handle
          .prepare('UPDATE pair SET hits = hits + 1, last_hit_at = ?, last_origin = ? WHERE id = ?')
          .run(Date.now(), origin, other.id)
        stats.hits += 1
        return { value: other.b, tone: other.tone }
      }
    }
    // 反向：这句话以前是译文，源文就在同一行；反向那半句与语气无关。
    const backward = handle
      .prepare('SELECT id, a_raw, a_han, tone FROM pair WHERE provider = ? AND b = ? LIMIT 1')
      .get(provider, text.trim()) as
      | { id: number; a_raw: string; a_han: number; tone: string }
      | undefined
    if (backward !== undefined && (backward.a_han === 1) === wantHan) {
      handle
        .prepare('UPDATE pair SET hits = hits + 1, last_hit_at = ?, last_origin = ? WHERE id = ?')
        .run(Date.now(), origin, backward.id)
      stats.hits += 1
      return { value: backward.a_raw, tone: backward.tone }
    }
    stats.misses += 1
    return null
  } catch (err) {
    stats.misses += 1
    console.log('TRANSLATE_CACHE_READ_FAILED', err instanceof Error ? err.message : String(err))
    return null
  }
}

/** 只要译文本身的老接口：跨语气兜底默认开着。 */
export function readTranslation(
  text: string,
  direction: string,
  provider: string,
  tone = '',
  origin: TranslationOrigin = 'capture',
  crossTone = true
): string | null {
  return lookupTranslation(text, direction, provider, tone, origin, crossTone)?.value ?? null
}

export function writeTranslation(
  text: string,
  provider: string,
  tone: string,
  value: string,
  meta: { direction: string; origin: TranslationOrigin }
): void {
  const trimmed = value.trim()
  if (trimmed.length === 0) return
  // 原样返回的行（模型没动、或本来就该原样）不值得记，记了只会把反向查询弄脏。
  if (trimmed === text.trim()) return
  const source = normalizeLine(text)
  if (source.length === 0) return
  const raw = text.trim()
  const now = Date.now()
  const handle = open()

  if (handle === null) {
    memory.set(pairKey(provider, tone, text), {
      tone,
      a: raw,
      b: trimmed,
      direction: meta.direction,
      origin: meta.origin,
      hits: 0
    })
    while (memory.size > MAX_PAIRS) {
      const oldest = memory.keys().next()
      if (oldest.done === true) break
      memory.delete(oldest.value)
      stats.evicted += 1
    }
    stats.writes += 1
    return
  }
  try {
    handle
      .prepare(
        `INSERT INTO pair (
           provider, tone, a, a_raw, b, a_han, direction, origin,
           a_len, b_len, a_words, b_words, hits, created_at, last_hit_at, last_origin
         )
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
         ON CONFLICT(provider, tone, a) DO UPDATE SET
           a_raw = excluded.a_raw,
           b = excluded.b,
           last_hit_at = excluded.last_hit_at,
           last_origin = excluded.last_origin`
      )
      .run(
        provider,
        tone,
        source,
        raw,
        trimmed,
        hasHan(text) ? 1 : 0,
        meta.direction,
        meta.origin,
        raw.length,
        trimmed.length,
        roughWordCount(raw),
        roughWordCount(trimmed),
        now,
        now,
        meta.origin
      )
    const total = (handle.prepare('SELECT COUNT(*) AS n FROM pair').get() as { n: number }).n
    if (total > MAX_PAIRS) {
      const overflow = total - MAX_PAIRS
      handle
        .prepare('DELETE FROM pair WHERE id IN (SELECT id FROM pair ORDER BY last_hit_at ASC LIMIT ?)')
        .run(overflow)
      stats.evicted += overflow
    }
    stats.writes += 1
  } catch (err) {
    console.log('TRANSLATE_CACHE_WRITE_FAILED', err instanceof Error ? err.message : String(err))
    // 坏库就挪走重建，再试一次；只重试一次，避免在真错误上打转。
    if (looksCorrupt(err)) {
      healCorruptDatabase(err instanceof Error ? err.message : String(err))
      try {
        const retry = open()
        if (retry !== null) retry.prepare('SELECT 1').get()
      } catch {
        // 重建也失败就让它降级到内存 Map
      }
    }
  }
}

export function translationCacheSize(): number {
  const handle = open()
  if (handle === null) return memory.size
  try {
    return (handle.prepare('SELECT COUNT(*) AS n FROM pair').get() as { n: number }).n
  } catch {
    return 0
  }
}

/**
 * 给词频统计留的出口：按命中次数倒序列出记账行。
 * 现在只有探针用，但统计功能要读的就是这些字段。
 */
export function translationCacheRows(limit = 5): Record<string, unknown>[] {
  const handle = open()
  if (handle === null) {
    return Array.from(memory.entries()).map(([key, pair]) => ({
      provider: key.split('|')[0],
      a_raw: pair.a,
      b: pair.b,
      direction: pair.direction,
      origin: pair.origin,
      hits: pair.hits
    }))
  }
  try {
    return handle
      .prepare(
        `SELECT provider, a_raw, b, a_han, direction, origin, a_len, b_len, a_words, b_words, hits, last_origin
         FROM pair ORDER BY hits DESC, last_hit_at DESC LIMIT ?`
      )
      .all(limit) as Record<string, unknown>[]
  } catch {
    return []
  }
}

/** 词频统计的读物：把预埋字段变成能看的数字。探针和面板共用同一份口径。 */
export interface TranslationInsights {
  /** 记账本里有几对（= 模型真正翻过几句）。 */
  pairs: number
  /** 这些对一共被取用几次（没调模型）。 */
  hits: number
  /** 命中占比：hits / (hits + pairs)，即「有多少次查库是白拿的」。 */
  hitRatio: number
  /** 按来源分组的对数。 */
  origins: Record<string, number>
  /** 源句 / 译句的平均字符数。 */
  averageA: number
  averageB: number
  /** 命中次数最多的几行。 */
  top: { a: string; b: string; hits: number; origin: string; direction: string }[]
}

const EMPTY_INSIGHTS: TranslationInsights = {
  pairs: 0,
  hits: 0,
  hitRatio: 0,
  origins: {},
  averageA: 0,
  averageB: 0,
  top: []
}

export function translationInsights(limit = 5): TranslationInsights {
  const handle = open()
  if (handle === null) {
    const real = Array.from(memory.values()).filter((pair) => pair.origin !== 'probe')
    const hits = real.reduce((sum, pair) => sum + pair.hits, 0)
    return {
      pairs: real.length,
      hits,
      hitRatio: round2(hits, hits + real.length),
      origins: tally(real.map((pair) => pair.origin)),
      averageA: round1(mean(real.map((pair) => pair.a.length))),
      averageB: round1(mean(real.map((pair) => pair.b.length))),
      top: real
        .slice()
        .sort((left, right) => right.hits - left.hits)
        .slice(0, limit)
        .map((pair) => ({
          a: pair.a,
          b: pair.b,
          hits: pair.hits,
          origin: pair.origin,
          direction: pair.direction
        }))
    }
  }
  try {
    const totals = handle
      .prepare(
        `SELECT COUNT(*) AS n, COALESCE(SUM(hits), 0) AS hits,
                COALESCE(AVG(a_len), 0) AS la, COALESCE(AVG(b_len), 0) AS lb
         FROM pair WHERE origin <> 'probe'`
      )
      .get() as { n: number; hits: number; la: number; lb: number }
    const origins = handle
      .prepare(`SELECT origin, COUNT(*) AS n FROM pair WHERE origin <> 'probe' GROUP BY origin`)
      .all() as { origin: string; n: number }[]
    const top = handle
      .prepare(
        `SELECT a_raw AS a, b, hits, origin, direction FROM pair
         WHERE origin <> 'probe' ORDER BY hits DESC, last_hit_at DESC LIMIT ?`
      )
      .all(limit) as { a: string; b: string; hits: number; origin: string; direction: string }[]
    return {
      pairs: totals.n,
      hits: totals.hits,
      hitRatio: round2(totals.hits, totals.hits + totals.n),
      origins: Object.fromEntries(origins.map((row) => [row.origin, row.n])),
      averageA: round1(totals.la),
      averageB: round1(totals.lb),
      top
    }
  } catch {
    return EMPTY_INSIGHTS
  }
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

function tally(values: string[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const value of values) out[value] = (out[value] ?? 0) + 1
  return out
}

function round1(value: number): number {
  return Math.round(value * 10) / 10
}

function round2(part: number, whole: number): number {
  if (whole === 0) return 0
  return Math.round((part / whole) * 100) / 100
}

export function translationCacheStats(): { entries: number; persisted: boolean } & typeof stats {
  return { entries: translationCacheSize(), persisted: db !== null, ...stats }
}
