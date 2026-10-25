import { app } from 'electron'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { summarizeStored, type StoredDump } from '../services/gsi-dump-analysis'
import { gsiSummaryPath } from '../services/gsi-frames-summary'
/** dev 应用与直跑探针的 userData 不同，两个位置都看一眼，取最新的。 */
function newestSummary(): string {
  const candidates = [
    gsiSummaryPath(),
    join(app.getPath('userData'), 'logs', 'gsi-summary.json')
  ]
  let best = gsiSummaryPath()
  let bestAt = -1
  for (const candidate of candidates) {
    try {
      const info = statSync(candidate)
      if (info.mtimeMs > bestAt) {
        bestAt = info.mtimeMs
        best = candidate
      }
    } catch {
      // 不存在就看下一个。
    }
  }
  return best
}
/**
 * `--gsi-dump-report [文件]`：读应用边打边记的 GSI 小结，离线判读。
 *
 * 和 `--gsi-dump` 的分工：那个要独占 32123 端口（得关掉应用），这个只读文件，
 * 应用开着、对局刚打完都能跑。默认读 `logs/gsi-summary.json`。
 */
export async function runGsiFramesReportProbe(): Promise<void> {
  const index = process.argv.indexOf('--gsi-dump-report')
  const arg = index >= 0 ? process.argv[index + 1] : undefined
  // 探针直接跑 out/main 时 userData 是 `Electron`，而真实应用是 `oh-my-dota2`，
  // 两边都要看，取最新的那份，避免「文件明明写过了却说没有」。
  const explicit = arg && !arg.startsWith('--') ? arg : null
  const file = explicit ?? newestSummary()

  if (!existsSync(file)) {
    console.log(
      'GSI_FRAMES_REPORT',
      JSON.stringify({
        ok: false,
        file,
        error: '还没有小结文件：先打一局（或让应用收到任意 GSI 帧），应用会自动写出'
      })
    )
    app.exit(1)
    return
  }

  let dump: StoredDump & { startedAt?: string; writtenAt?: string }
  try {
    dump = JSON.parse(readFileSync(file, 'utf8')) as StoredDump & { startedAt?: string; writtenAt?: string }
  } catch (error) {
    console.log(
      'GSI_FRAMES_REPORT',
      JSON.stringify({ ok: false, file, error: '小结文件解析失败', detail: String(error) })
    )
    app.exit(1)
    return
  }

  const summary = summarizeStored(dump)
  console.log(
    'GSI_FRAMES_REPORT',
    JSON.stringify(
      {
        ok: summary.frames > 0,
        file,
        startedAt: dump.startedAt ?? null,
        writtenAt: dump.writtenAt ?? null,
        frames: summary.frames,
        realMatch: summary.realMatch,
        matchIds: summary.matchIds,
        allplayersFrames: summary.allplayersFrames,
        eventKinds: summary.events.map((item) => ({ type: item.type, count: item.count })),
        blocks: summary.blocks,
        verdict: summary.verdict
      },
      null,
      2
    )
  )
  if (summary.events.length > 0) {
    console.log('GSI_FRAMES_EVENTS', JSON.stringify(summary.events.map((item) => item.samples[0])))
  }
  app.exit(summary.frames > 0 ? 0 : 1)
}
