import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { DatabaseSync } from 'node:sqlite'
import { normalizeLine } from '../services/capture/chat-lines'

/**
 * 一局成绩单：把 `gsi-chat.jsonl` 与翻译账本对一次账。
 *
 * 抓屏 OCR 移除后，「漏行」这个指标就没有第二只手来对照了 —— 能问的问题变成：
 * Dota 一共推了多少条、去重后多少条、重复了多少帧、哪些句子没进账本。
 * 只读日志，对局进行中也能跑。
 */

interface ChatRow {
  at: string
  channel: number
  slot: number
  own: boolean
  gameTime: number
  text: string
}

interface UniqueMessage {
  key: string
  channel: number
  name: string
  text: string
  own: boolean
  gameTime: number
  repeats: number
}

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * ratio)))
  return sorted[index]
}

function chatLogPath(dir: string): string {
  return join(dir, 'gsi-chat.jsonl')
}

function readChatLog(dir: string): ChatRow[] {
  const path = chatLogPath(dir)
  if (!existsSync(path)) return []
  const rows: ChatRow[] = []
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as Partial<ChatRow>
      if (typeof parsed.text !== 'string') continue
      rows.push({
        at: parsed.at ?? '',
        channel: parsed.channel ?? 0,
        slot: parsed.slot ?? 0,
        own: parsed.own === true,
        gameTime: parsed.gameTime ?? 0,
        text: parsed.text
      })
    } catch {
      // 半行（进程被杀时最后一行可能不完整）忽略。
    }
  }
  return rows
}

/** Dota 每条聊天连推约 26 帧，按 时间+槽位+频道+正文 收敛成一条独立消息。 */
function dedupeChat(rows: ChatRow[]): UniqueMessage[] {
  const out = new Map<string, UniqueMessage>()
  for (const row of rows) {
    const key = `${row.gameTime}|${row.slot}|${row.channel}|${row.text}`
    const hit = out.get(key)
    if (hit) hit.repeats += 1
    else
      out.set(key, {
        key,
        channel: row.channel,
        name: '',
        text: row.text,
        own: row.own,
        gameTime: row.gameTime,
        repeats: 1
      })
  }
  return [...out.values()]
}

function tally<T extends string>(values: T[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const value of values) out[value] = (out[value] ?? 0) + 1
  return out
}

function sinceArgv(): number {
  const at = process.argv.indexOf('--since-min')
  const raw = at >= 0 ? process.argv[at + 1] : undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 ? value : 0
}

function ledgerCoverage(
  logsDir: string,
  texts: string[]
): { checked: number; matched: number; missRate: number | null; missed: string[] } {
  const path = join(logsDir, '..', 'translate-cache.sqlite')
  if (!existsSync(path) || texts.length === 0) {
    return { checked: texts.length, matched: 0, missRate: null, missed: [] }
  }
  const db = new DatabaseSync(path)
  try {
    const rows = db.prepare(`SELECT a_raw FROM pair WHERE origin = 'capture'`).all() as Array<{
      a_raw: string | null
    }>
    const known = new Set(rows.map((row) => normalizeLine(row.a_raw ?? '')).filter(Boolean))
    const missed = texts.filter((text) => !known.has(normalizeLine(text)))
    return {
      checked: texts.length,
      matched: texts.length - missed.length,
      missRate: texts.length > 0 ? Math.round((missed.length / texts.length) * 1000) / 1000 : null,
      missed: missed.slice(0, 8)
    }
  } finally {
    db.close()
  }
}

export async function runMatchReportProbe(): Promise<void> {
  const arg = process.argv[process.argv.indexOf('--match-report') + 1]
  const dir = arg && !arg.startsWith('--') ? arg : null
  const logsDir = dir ?? join(app.getPath('userData'), 'logs')

  const sinceMin = sinceArgv()
  const cutoff = sinceMin > 0 ? Date.now() - sinceMin * 60_000 : 0
  const chatRows = readChatLog(logsDir).filter((row) => cutoff === 0 || Date.parse(row.at) >= cutoff)
  const unique = dedupeChat(chatRows)
  const byChannel = tally(unique.map((row) => String(row.channel)))
  const repeats = unique.map((row) => row.repeats)
  const ledger = ledgerCoverage(
    logsDir,
    unique.filter((row) => !row.own).map((row) => row.text)
  )

  const report = {
    logsDir,
    sinceMin,
    window:
      chatRows.length > 0
        ? [Date.parse(chatRows[0].at), Date.parse(chatRows[chatRows.length - 1].at)]
        : [],
    ledger,
    gsi: {
      frames: chatRows.length,
      unique: unique.length,
      repeats: {
        median: percentile(repeats, 0.5),
        max: repeats.length > 0 ? Math.max(...repeats) : 0
      },
      byChannel,
      own: unique.filter((row) => row.own).length,
      gameTime: unique.length > 0 ? [unique[0].gameTime, unique[unique.length - 1].gameTime] : [],
      sample: unique.slice(-5).map((row) => `[${row.channel}] ${row.text} ×${row.repeats}`)
    }
  }

  const hints: string[] = []
  if (unique.length === 0) hints.push('没有 GSI 聊天记录：检查 cfg 的 events 块与 Dota 是否重启过')
  if (ledger.missRate !== null && ledger.missRate > 0) {
    hints.push(
      `账本里查不到 ${ledger.missed.length >= 8 ? '8+' : ledger.missed.length} 句正文：漏行 ${Math.round(ledger.missRate * 100)}%`
    )
  }
  if (unique.length > 0 && (report.gsi.repeats.max ?? 0) < 2) {
    hints.push('没有重复帧：可能是手动灌的合成数据，或事件去重窗口被改过')
  }

  console.log('MATCH_REPORT', JSON.stringify(report))
  for (const hint of hints) console.log(`  ! ${hint}`)
  console.log(`  GSI ${unique.length} 句 / ${chatRows.length} 帧，重复最多 ${report.gsi.repeats.max} 帧`)
  app.exit(0)
}
