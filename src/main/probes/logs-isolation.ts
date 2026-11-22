import { exitProbe, probeCases } from './harness'
import { app } from 'electron'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PROBES } from './registry'
import { logsDir } from '../services/logs/base-dir'
import { appendTrainLog, trainLogPath } from '../services/train/log-file'
import { guardLogPath } from '../services/session/guard-telemetry'
import {
  gsiSummaryArchiveDir,
  gsiSummaryPath,
  recordFrameSummary,
  resetFrameSummary
} from '../services/gsi-frames-summary'

/**
 * 探针自己不许写用户数据（`--logs-isolation-probe`，ci: true）。
 *
 * 这条和「某个探针写得对不对」无关，它钉的是**框架级的默认值**：只要进程是以探针身份
 * 起来的，`logsDir()` 就必须指向临时目录，而不是 `<userData>/logs`。以前没有这条默认值，
 * 于是 `--match-attribution-probe` 把假 matchid 留在真实的 `logs/gsi-summary.json` 里
 * （下一局复盘把它当成真对局），`--voice-chain-probe` 直接把真实 `voice-chain.jsonl`
 * 清空——两处都是玩家数据，两处都靠「每个探针自己记得改」才没出事，而人总会忘（#126）。
 *
 * 判据只有两条：写日志的任何一条腿（summary / voice-chain / archive）都落在临时根下；
 * 真实文件在这个探针跑完之后逐字节没变。
 */
export async function runLogsIsolationProbe(): Promise<void> {
  const { cases, push } = probeCases()

  const realLogs = join(app.getPath('userData'), 'logs')
  const dir = logsDir()
  push(
    '探针进程的 logsDir 不在真实 userData 下',
    dir !== realLogs && !dir.startsWith(realLogs),
    `${dir} vs ${realLogs}`
  )
  push('logsDir 是临时目录（mkdtemp 形状）', dir.includes('omd2-probe-logs-'), dir)
  push(
    'summary 活文件跟着临时根走',
    gsiSummaryPath() === join(dir, 'gsi-summary.json'),
    gsiSummaryPath()
  )
  push(
    'summary 归档目录也跟着临时根走',
    gsiSummaryArchiveDir() === join(dir, 'gsi-summary'),
    gsiSummaryArchiveDir()
  )

  // 真写一次：如果这一层缝破了，下面这条断言会看到真实文件被改动。
  // #185：`train.log` 曾经绕过这条缝（探针跑一次就往真实训练历史里塞假 epoch）。
  // 覆盖它的方式不是「看一眼代码」，而是真写一次、再核真实文件逐字节没变。
  push(
    'train.log 从 logsDir() 派生',
    trainLogPath() === join(dir, 'train.log'),
    trainLogPath()
  )
  push(
    'translate-guard.jsonl 也从 logsDir() 派生',
    guardLogPath() === join(dir, 'translate-guard.jsonl'),
    guardLogPath()
  )
  const realTrain = trainLogPath().replace(dir, realLogs)
  const trainBefore = existsSync(realTrain) ? readFileSync(realTrain).length : -1
  appendTrainLog('epoch 9/10 · logs-isolation-probe')
  const trainAfter = existsSync(realTrain) ? readFileSync(realTrain).length : -1
  const tempTrain = existsSync(trainLogPath()) ? readFileSync(trainLogPath(), 'utf8') : ''
  push(
    '训练日志写进了临时目录（否则下一条是空转）',
    tempTrain.includes('logs-isolation-probe'),
    `${tempTrain.length} bytes`
  )
  push(
    '真实 train.log 逐字节没变（探针不再往用户训练历史里追加）',
    trainBefore === trainAfter,
    `${trainBefore} → ${trainAfter} bytes`
  )
  const realSummary = join(realLogs, 'gsi-summary.json')
  const before = existsSync(realSummary) ? readFileSync(realSummary, 'utf8') : null
  const fakeFrame = { map: { matchid: '9999000001', game_time: 120, clock_time: 120 } }
  recordFrameSummary(fakeFrame)
  recordFrameSummary(fakeFrame)
  const wroteTemp = existsSync(gsiSummaryPath())
  const tempText = wroteTemp ? readFileSync(gsiSummaryPath(), 'utf8') : ''
  resetFrameSummary()

  const after = existsSync(realSummary) ? readFileSync(realSummary, 'utf8') : null
  push('合成帧真的写进了临时目录（否则下面那条断言是空转）', wroteTemp && tempText.includes('9999000001'), `${tempText.length} bytes`)
  push(
    '真实 gsi-summary.json 逐字节没变（合成局没漏进用户数据）',
    after === before,
    `${before === null ? 'absent' : `${before.length} bytes`} → ${after === null ? 'absent' : `${after.length} bytes`}`
  )
  push(
    '标了 realLogs 的探针是白名单，不是默认值',
    PROBES.filter((probe) => probe.realLogs === true).length < PROBES.length / 2,
    `${PROBES.filter((probe) => probe.realLogs === true).length}/${PROBES.length} 条`
  )

  for (const item of cases) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name} ${item.detail}`)
  const failed = cases.filter((item) => !item.ok)
  console.log(
    'LOGS_ISOLATION_PROBE',
    JSON.stringify({ ok: failed.length === 0, passed: cases.length - failed.length, failed: failed.length, dir })
  )
  exitProbe(failed.length === 0, cases)
}
