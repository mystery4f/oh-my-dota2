/**
 * #119 一局一张战绩图（纯逻辑）。
 *
 * 票面只许用记下来的数字：
 * - 「听懂的句数」= `logs/voice-chain.jsonl` 里 `spoken === true` 的行数；
 * - 「被标出的行数」= `stage` 为 `'mic'` / `'translate'` / `'voice-out'` 的行数（这几条就是
 *   链路自己写下的失败标记），其它 stage 不认识也照原样报出来，绝不猜成「听懂」；
 * - 「首音中位」= 有 `firstAudioMs` 的行的中位数。
 *
 * 一条对局里没有任何语音活动时，图**照样出**，正文第一句就是
 * 「这一局没有语音活动」——空图比缺图更容易被误读成「工具坏了」。
 */

/** 一行语音链路记录（`logs/voice-chain.jsonl` 的一行）。字段都能缺，缺了就不算数。 */
export interface MatchReportRow {
  at?: string
  spoken?: boolean
  stage?: string | null
  chars?: number
  segments?: number
  firstAudioMs?: number | null
  totalMs?: number | null
}

export interface MatchReportNumbers {
  rows: number
  understood: number
  flagged: number
  firstAudioMs: number | null
  totalMs: number | null
}

export interface MatchReport extends MatchReportNumbers {
  matchId: string
  generatedAt: string
  headline: string
  detail: string
}

/** 这些 stage 是链路写下的失败标记，算「被标出」而不是「听懂」。 */
const FLAG_STAGES = new Set(['mic', 'translate', 'voice-out'])

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

/** 只统计真记下来的数字：`spoken` 缺省不算听懂，`stage` 缺省不算标出。 */
export function matchReportNumbers(rows: readonly MatchReportRow[]): MatchReportNumbers {
  const firstAudio: number[] = []
  const totals: number[] = []
  let understood = 0
  let flagged = 0
  for (const row of rows) {
    if (row.spoken === true) understood += 1
    if (typeof row.stage === 'string' && FLAG_STAGES.has(row.stage)) flagged += 1
    if (typeof row.firstAudioMs === 'number' && Number.isFinite(row.firstAudioMs)) firstAudio.push(row.firstAudioMs)
    if (typeof row.totalMs === 'number' && Number.isFinite(row.totalMs)) totals.push(row.totalMs)
  }
  return { rows: rows.length, understood, flagged, firstAudioMs: median(firstAudio), totalMs: median(totals) }
}

export function matchReportOf(rows: readonly MatchReportRow[], input: { matchId?: string; generatedAt?: string } = {}): MatchReport {
  const numbers = matchReportNumbers(rows)
  const matchId = (input.matchId ?? '').trim() || '未知对局'
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  if (numbers.rows === 0) {
    return { ...numbers, matchId, generatedAt, headline: '这一局没有语音活动', detail: '没有一条语音链路记录可统计：对讲、同传、朗读都没被用过。' }
  }
  const firstAudio = numbers.firstAudioMs === null ? '没有首音样本' : `首音中位 ${Math.round(numbers.firstAudioMs)} ms`
  return {
    ...numbers,
    matchId,
    generatedAt,
    headline: `听懂 ${numbers.understood} 句 · 标出 ${numbers.flagged} 行`,
    detail: `${firstAudio} · 共 ${numbers.rows} 条语音链路记录`,
  }
}

const SVG_WIDTH = 720
const SVG_HEIGHT = 260

function esc(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/**
 * 一张图，纯字符串，不碰文件系统也没有随机数——同一个 `MatchReport` 永远画出同一张图，
 * 探针可以直接逐字断言它画的是记录里的数字。
 */
export function matchReportSvg(report: MatchReport): string {
  const rows = [
    `听懂 ${report.understood} 句`,
    `标出 ${report.flagged} 行`,
    report.firstAudioMs === null ? '首音 无样本' : `首音中位 ${Math.round(report.firstAudioMs)} ms`,
    report.totalMs === null ? '整条 无样本' : `整条中位 ${Math.round(report.totalMs)} ms`,
  ]
  const cells = rows
    .map((text, index) => {
      const x = 40 + index * 165
      return `<text x="${x}" y="200" font-size="20" fill="#e8eaed">${esc(text)}</text>`
    })
    .join('')
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${SVG_WIDTH}" height="${SVG_HEIGHT}" viewBox="0 0 ${SVG_WIDTH} ${SVG_HEIGHT}">`,
    '<rect width="100%" height="100%" fill="#101216"/>',
    `<text x="40" y="56" font-size="14" fill="#9aa0a6">oh-my-dota2 · 对局 ${esc(report.matchId)}</text>`,
    `<text x="40" y="96" font-size="26" fill="#f5f6f7">${esc(report.headline)}</text>`,
    `<text x="40" y="130" font-size="14" fill="#9aa0a6">${esc(report.detail)}</text>`,
    cells,
    `<text x="40" y="240" font-size="11" fill="#6b7280">${esc(report.generatedAt)} · 数字全部来自 logs/voice-chain.jsonl</text>`,
    '</svg>',
  ].join('\n')
}

/** 图里那句总结也单独给一份，方便面板不再画一遍。 */
export function matchReportLine(report: MatchReport): string {
  return `${report.headline}｜${report.detail}`
}
