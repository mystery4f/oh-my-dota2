/**
 * 译文抽检（#87）：对局里把某一句译文标成「好」或「差」，攒成可比对的样本。
 *
 * 为什么只记被标记过的：没标记的行没有结论，攒起来只是噪声——把「没被骂」当「译得对」，
 * 算出来的好评率是假的。所以记录只有两种来源，人在浮层上按了键（两个热键）。
 *
 * 存的是什么：原文、译文、判定、matchid（#73 的归属规则：只认 90 秒内活着的帧，拿不到写 null），
 * 以及当时的 provider / model —— 换供应商之后要能分清哪条样本属于谁。缓存命中（`cached`）
 * 也记下来，因为「记账本直接给的」和「现翻的」出问题的概率不是一回事。
 *
 * 这个文件只有纯逻辑：记录的形状、去重键、聚合与排名。写盘、读设置、取 matchid 都在主进程。
 */

export type TranslationVerdict = 'good' | 'bad'

/** 一条被标记的译文。`matchid` 为 null = 那一刻没有活着的 GSI 帧，不是「上一局」。 */
export interface TranslationMark {
  at: string
  matchid: string | null
  /** 浮层上那一行的 id（`CaptureEntry.id`）：同一行改判时按它去重。 */
  entryId: string
  source: string
  translation: string
  verdict: TranslationVerdict
  provider: string
  model: string
  /** 译文直接来自翻译记账本（没调模型）。 */
  cached: boolean
}

/** 一条记录的最小输入：主进程补齐 at / matchid / provider / model。 */
export interface TranslationMarkInput {
  at: string
  matchid: string | null
  entry: { id: string; body: string; translated: string | null; cached?: boolean }
  verdict: TranslationVerdict
  provider: string
  model: string
}

/** 每组（供应商 × 模型）的判定结果。 */
export interface VerdictTally {
  provider: string
  model: string
  good: number
  bad: number
  total: number
  /** 好评占比（0–1）。total 为 0 时是 0，不是 NaN。 */
  goodRate: number
}

export interface TranslationMarkSummary {
  total: number
  good: number
  bad: number
  /** 按组排好序：好评率高的在前，同率按样本多的在前。 */
  tallies: VerdictTally[]
  /** 有标记的最近一条（时间串）。没有标记时 null。 */
  newest: string | null
  /** 有多少条标记带得上 matchid。 */
  attributed: number
}

/** 同一行只能有一个结论：后来的一键改判覆盖前一次。 */
export function markKey(mark: Pick<TranslationMark, 'entryId'>): string {
  return mark.entryId
}

/**
 * 把一条输入变成记录。拒绝三种情况——没有译文、原文为空、译文为空：
 * 那三条都说明「这一行没有被翻译过」，标它没有意义，也绝不能悄悄记一条空样本。
 */
export function buildMark(input: TranslationMarkInput): TranslationMark | null {
  const source = input.entry.body.trim()
  const translation = (input.entry.translated ?? '').trim()
  if (source === '' || translation === '') return null
  return {
    at: input.at,
    matchid: input.matchid,
    entryId: input.entry.id,
    source,
    translation,
    verdict: input.verdict,
    provider: input.provider,
    model: input.model,
    cached: input.entry.cached === true
  }
}

/** 同一 entryId 只留一条（后来的为准），其余按时间顺序保留。 */
export function dedupeMarks(marks: readonly TranslationMark[]): TranslationMark[] {
  const byId = new Map<string, TranslationMark>()
  const order: string[] = []
  for (const mark of marks) {
    const key = markKey(mark)
    if (!byId.has(key)) order.push(key)
    byId.set(key, mark)
  }
  return order.map((key) => byId.get(key) as TranslationMark)
}

function tallyOf(marks: readonly TranslationMark[]): VerdictTally[] {
  const buckets = new Map<string, VerdictTally>()
  for (const mark of marks) {
    const key = `${mark.provider}|${mark.model}`
    const found = buckets.get(key)
    const tally = found ?? { provider: mark.provider, model: mark.model, good: 0, bad: 0, total: 0, goodRate: 0 }
    if (mark.verdict === 'good') tally.good += 1
    else tally.bad += 1
    tally.total += 1
    buckets.set(key, tally)
  }
  const list = Array.from(buckets.values())
  for (const tally of list) tally.goodRate = tally.total === 0 ? 0 : tally.good / tally.total
  return list.sort((a, b) => {
    if (b.goodRate !== a.goodRate) return b.goodRate - a.goodRate
    if (b.total !== a.total) return b.total - a.total
    return `${a.provider}|${a.model}`.localeCompare(`${b.provider}|${b.model}`)
  })
}

export function summarizeMarks(marks: readonly TranslationMark[]): TranslationMarkSummary {
  const rows = dedupeMarks(marks)
  const good = rows.filter((mark) => mark.verdict === 'good').length
  return {
    total: rows.length,
    good,
    bad: rows.length - good,
    tallies: tallyOf(rows),
    newest: rows.length === 0 ? null : rows.reduce((newest, mark) => (mark.at > newest ? mark.at : newest), rows[0].at),
    attributed: rows.filter((mark) => mark.matchid !== null).length
  }
}

/** 面板/浮层的一句话。0 条时说的是「还没标过」，不是「全部译得对」。 */
export function marksLine(summary: TranslationMarkSummary): string {
  if (summary.total === 0) return '还没标过译文（对局里按「标记译文：好/差」两个热键）'
  const parts = summary.tallies.map(
    (tally) => `${tally.provider}/${tally.model} ${Math.round(tally.goodRate * 100)}%（${tally.good}/${tally.total}）`
  )
  return `${summary.total} 条标记 · 好 ${summary.good} · 差 ${summary.bad} · ${parts.join(' · ')}`
}

/** 标记回来的即时反馈：热键不许静默，被拒绝时也要说清为什么。 */
export function markFeedback(verdict: TranslationVerdict, built: TranslationMark | null): string {
  const name = verdict === 'good' ? '好' : '差'
  if (built === null) return `没有可标记的译文：浮层上最近一行还没翻出来`
  return `已标记最近一句译文：${name}（${built.provider}/${built.model}${built.matchid === null ? '，未归属' : ''}）`
}
