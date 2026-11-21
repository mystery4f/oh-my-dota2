/**
 * #119 战绩图落盘：只读记下来的东西，写一张 svg。
 *
 * 数据来源只有两处，都在 `logsDir()` 下面（所以探针能把它们重定向到临时目录）：
 * - `voice-chain.jsonl`：每行一条语音链路记录，战绩图的全部数字都从这里来；
 * - `gsi-summary.json`：当前对局的 `map.matchid`，只用来给图起名。
 *
 * 读不到就按空算：没有记录时出一张写着「这一局没有语音活动」的图，而不是报错。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { matchReportOf, matchReportSvg, type MatchReport, type MatchReportRow } from '@shared/match-report'
import { logsDir } from '../logs/base-dir'

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** 一行一条 JSON；坏行（截断、乱码）直接跳过，绝不让一行坏数据让整张图消失。 */
export function parseMatchReportRows(text: string): MatchReportRow[] {
  const rows: MatchReportRow[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (line === '' || !line.startsWith('{')) continue
    try {
      const parsed: unknown = JSON.parse(line)
      if (typeof parsed === 'object' && parsed !== null) rows.push(parsed as MatchReportRow)
    } catch {
      continue
    }
  }
  return rows
}

/** `gsi-summary.json` 里的对局 id；拿不到就返回空串（图上写「未知对局」，不编一个）。 */
export function matchIdFromSummary(text: string): string {
  if (text.trim() === '') return ''
  try {
    const parsed: unknown = JSON.parse(text)
    const map = (parsed as { map?: { matchid?: unknown } }).map
    const id = map?.matchid
    return typeof id === 'string' || typeof id === 'number' ? String(id) : ''
  } catch {
    return ''
  }
}

export interface MatchReportExportResult {
  ok: boolean
  path: string
  report: MatchReport
  error: string | null
}

/**
 * 出图并落盘到 `<logs>/export/match-report-<id>.svg`。
 * 文件名里的 id 去掉一切路径分隔符与空白——对局 id 来自游戏，不能直接信。
 */
export function writeMatchReport(
  options: { dir?: string; at?: string; matchId?: string } = {}
): MatchReportExportResult {
  const dir = options.dir ?? logsDir()
  const rows = parseMatchReportRows(readText(join(dir, 'voice-chain.jsonl')))
  const matchId = options.matchId ?? matchIdFromSummary(readText(join(dir, 'gsi-summary.json')))
  const report = matchReportOf(rows, { matchId, generatedAt: options.at })
  const safeId = report.matchId.replace(/[^A-Za-z0-9._-]+/g, '').slice(0, 24) || 'unknown'
  const outDir = join(dir, 'export')
  const path = join(outDir, `match-report-${safeId}.svg`)
  try {
    if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true })
    writeFileSync(path, matchReportSvg(report), 'utf8')
    console.log('MATCH_REPORT ' + JSON.stringify({ path, rows: report.rows, understood: report.understood, flagged: report.flagged }))
    return { ok: true, path, report, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log('MATCH_REPORT_FAIL ' + JSON.stringify({ path, error: message }))
    return { ok: false, path, report, error: message }
  }
}
