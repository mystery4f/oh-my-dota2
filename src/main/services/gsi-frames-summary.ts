import { app } from 'electron'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { GsiPayload } from './gsi'
import { createTally, summarize, tallyFrame, type DumpTally } from './gsi-dump-analysis'
import { archiveSummary, pruneSummaries } from './gsi-summary-archive'

/**
 * 把「这局 Dota 到底推了什么」边打边记账，落成一份可离线判读的小结。
 *
 * 为什么要在应用里记：`--gsi-dump` 要独占 32123 端口，而端口被 dev 应用占着——
 * 想看真对局数据就必须关应用，反过来真对局时又开着应用。于是改成应用自己攒：
 * 内存里按字段/事件归类，每 5 秒落一次盘（原子替换），一局打完直接读文件就能判断
 * 「是不是真对局」「allplayers 给不给」「有多少种事件」。
 *
 * 活文件只装「当下这一局」；换局/收场时把这一局另存一份 `gsi-summary/<matchid>.json`，
 * 否则下一局一开打，上一局的结论就被覆盖——复盘页要的是连续几局，不是最后一局。
 */
const FILE_NAME = 'gsi-summary.json'
const ARCHIVE_DIR = 'gsi-summary'
const WRITE_EVERY_MS = 5_000

let tally: DumpTally = createTally()
let startedAt = Date.now()
let writtenAt = 0
let currentMatch = ''
let frames = 0

export function gsiSummaryPath(): string {
  return join(app.getPath('userData'), 'logs', FILE_NAME)
}

/** 按局归档的目录：`<userData>/gsi-summary/<matchid>.json`。 */
export function gsiSummaryArchiveDir(): string {
  return join(app.getPath('userData'), 'logs', ARCHIVE_DIR)
}

/** 换局就清账：否则上一局的 matchid、事件统计会污染这一局的结论。 */
function resetTally(): void {
  tally = createTally()
  startedAt = Date.now()
  frames = 0
}

function snapshot(): Record<string, unknown> {
  return {
    matchid: currentMatch.length > 0 ? currentMatch : null,
    writtenAt: new Date().toISOString(),
    startedAt: new Date(startedAt).toISOString(),
    ...summarize(tally)
  }
}

function flush(): void {
  const file = gsiSummaryPath()
  try {
    mkdirSync(dirname(file), { recursive: true })
    const temp = file + '.tmp'
    writeFileSync(temp, JSON.stringify(snapshot(), null, 2), 'utf8')
    renameSync(temp, file)
  } catch {
    // 写小结失败不影响对局本身，静默跳过。
  }
}

/**
 * 把当下这一局另存一份并裁剪旧档。
 * 没有 matchid 就不归档：训练场/主菜单攒出来的账本没有归属，留着只会让复盘页去猜。
 */
function archiveCurrent(): void {
  if (currentMatch.length === 0 || frames === 0) return
  const dir = gsiSummaryArchiveDir()
  archiveSummary(dir, currentMatch, snapshot())
  pruneSummaries(dir, currentMatch)
}

/** 每帧调用；内部做节流落盘与换局重置。 */
export function recordFrameSummary(payload: GsiPayload): void {
  const matchId = typeof payload.map?.matchid === 'string' ? payload.map.matchid : ''
  if (matchId.length > 0 && matchId !== currentMatch) {
    // 换局前先把上一局收好：只等 POST_GAME 会漏掉「没打完就进下一局」（秒排、掉线重开）。
    archiveCurrent()
    currentMatch = matchId
    resetTally()
    writtenAt = Date.now()
    // 活文件立刻重写成新一局（此刻还是空账本），不让它继续挂着上一局的内容。
    flush()
  }
  tallyFrame(tally, payload)
  frames += 1
  const now = Date.now()
  if (now - writtenAt < WRITE_EVERY_MS) return
  writtenAt = now
  flush()
}

/** 对局结束或应用退出时立刻落一次，别把最后一局的结论留在内存里。 */
export function flushFrameSummary(): void {
  if (frames === 0) return
  writtenAt = Date.now()
  flush()
  archiveCurrent()
}

/** 仅供探针/测试：把内存里的账本清空（不影响已落盘的文件）。 */
export function resetFrameSummary(): void {
  currentMatch = ''
  resetTally()
}
