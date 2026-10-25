import { app } from 'electron'
import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { GsiPayload } from './gsi'
import { createTally, summarize, tallyFrame, type DumpTally } from './gsi-dump-analysis'

/**
 * 把「这局 Dota 到底推了什么」边打边记账，落成一份可离线判读的小结。
 *
 * 为什么要在应用里记：`--gsi-dump` 要独占 32123 端口，而端口被 dev 应用占着——
 * 想看真对局数据就必须关应用，反过来真对局时又开着应用。于是改成应用自己攒：
 * 内存里按字段/事件归类，每 5 秒落一次盘（原子替换），一局打完直接读文件就能判断
 * 「是不是真对局」「allplayers 给不给」「有多少种事件」。
 */
const FILE_NAME = 'gsi-summary.json'
const WRITE_EVERY_MS = 5_000

let tally: DumpTally = createTally()
let startedAt = Date.now()
let writtenAt = 0
let currentMatch = ''
let frames = 0

export function gsiSummaryPath(): string {
  return join(app.getPath('userData'), 'logs', FILE_NAME)
}

/** 换局就清账：否则上一局的 matchid、事件统计会污染这一局的结论。 */
function resetTally(): void {
  tally = createTally()
  startedAt = Date.now()
  frames = 0
}

function flush(): void {
  const file = gsiSummaryPath()
  const payload = {
    writtenAt: new Date().toISOString(),
    startedAt: new Date(startedAt).toISOString(),
    ...summarize(tally)
  }
  try {
    mkdirSync(dirname(file), { recursive: true })
    const temp = file + '.tmp'
    writeFileSync(temp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(temp, file)
  } catch {
    // 写小结失败不影响对局本身，静默跳过。
  }
}

/** 每帧调用；内部做节流落盘与换局重置。 */
export function recordFrameSummary(payload: GsiPayload): void {
  const matchId = typeof payload.map?.matchid === 'string' ? payload.map.matchid : ''
  if (matchId.length > 0 && matchId !== currentMatch) {
    currentMatch = matchId
    resetTally()
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
}

/** 仅供探针/测试：把内存里的账本清空（不影响已落盘的文件）。 */
export function resetFrameSummary(): void {
  currentMatch = ''
  resetTally()
}
