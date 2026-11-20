/**
 * 保真守卫的遥测口径：三段计数，没有第四段。
 *
 * - `blocked`：守卫判出拉丁 token 违例的次数（= 事件行数）
 * - `recovered`：清场重试后通过
 * - `gaveUp`：重试后仍违例，译文退成原文（调用方按「译文 === 原文」处理）
 *
 * **没有「漏检率」**：模型把 bkb 写坏而守卫没抓到时，代码里没有第二个判官；硬造一个
 * 等于再跑一遍模型，成本和延迟都受不了。所以对外只能说「抓到 X 次」，不能反推准确率。
 *
 * 纯类型 + 纯函数（不碰 fs、不碰 electron）：写盘在主进程
 * （`services/session/guard-telemetry.ts`），探针直接喂事件断言这份口径。
 */
import type { TranslateDirection } from './ipc'

/** 违例事件的结局：重试救回来了，还是回退成了原文。 */
export type GuardOutcome = 'recovered' | 'gaveup'

/** 一次违例。判违例时先记 tokens，结局出来后补 outcome。 */
export interface GuardEvent {
  at: string
  /** 哪条车道判的：会话（durable-translator 的 submitOnce）还是直连（translateText）。 */
  via: 'session' | 'direct'
  direction: TranslateDirection
  /** 第一遍违例的 token（小写，按源文出现顺序去重）。 */
  tokens: string[]
  /** 放弃时第二遍仍然违例的 token；通过了就是空数组。 */
  retryTokens: string[]
  outcome: GuardOutcome
}

export interface GuardTally {
  blocked: number
  recovered: number
  gaveUp: number
  /** 违例 token 出现次数，多的在前；同次数按 token 名字排，口径稳定可对比。 */
  tokens: { token: string; count: number }[]
}

/** 汇总一段事件（读 jsonl 的调用方自己 parse 再喂进来）。 */
export function summarizeGuardEvents(events: readonly GuardEvent[]): GuardTally {
  const tally: GuardTally = { blocked: events.length, recovered: 0, gaveUp: 0, tokens: [] }
  const counts = new Map<string, number>()
  for (const event of events) {
    if (event.outcome === 'recovered') tally.recovered += 1
    else tally.gaveUp += 1
    for (const token of event.tokens) counts.set(token, (counts.get(token) ?? 0) + 1)
  }
  tally.tokens = [...counts.entries()]
    .map(([token, count]) => ({ token, count }))
    .sort((left, right) => right.count - left.count || left.token.localeCompare(right.token))
  return tally
}

/**
 * 一行 jsonl 还原成事件；不是完整事件就返回 null。
 *
 * 抓屏/翻译跑一整晚，文件尽头常常是一条被截断的半行（进程被 kill 时写到一半），
 * 统计直接从 jsonl 读，所以脏行必须在入口就丢掉，不能让一个 JSON.parse 异常把整份汇总带塌。
 */
export function parseGuardEvent(line: string): GuardEvent | null {
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
  const outcome = row.outcome
  const via = row.via
  if (outcome !== 'recovered' && outcome !== 'gaveup') return null
  if (via !== 'session' && via !== 'direct') return null
  if (typeof row.at !== 'string' || row.at.length === 0) return null
  const tokens = Array.isArray(row.tokens) ? row.tokens.filter((item): item is string => typeof item === 'string') : null
  if (tokens === null) return null
  const retryTokens = Array.isArray(row.retryTokens)
    ? row.retryTokens.filter((item): item is string => typeof item === 'string')
    : []
  return {
    at: row.at,
    via,
    direction: row.direction === 'zh-en' || row.direction === 'auto-zh' ? row.direction : 'en-zh',
    tokens,
    retryTokens,
    outcome
  }
}

/** 从整份 jsonl 文本算出周报要的那几个数。 */
export function summarizeGuardLog(text: string): GuardTally {
  const events: GuardEvent[] = []
  for (const line of text.split('\n')) {
    const event = parseGuardEvent(line)
    if (event !== null) events.push(event)
  }
  return summarizeGuardEvents(events)
}
