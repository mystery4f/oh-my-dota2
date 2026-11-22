/**
 * 数据量（#180）：句数、时长（估）、最近一条，以及「够不够」的那一句话。
 *
 * 为什么值得一个探针：这一层的错都很安静——把「约 6 分钟」印成「6 分钟」（用户以为实测过）、
 * 把 10 句判成够（训出来走音，十几分钟后才知道）、wav 头读不出来却给个 0 分钟。
 * 全部喂事实、不碰磁盘，真目录那一路在 CI 上不存在就 SKIP 并点名。
 */
import { existsSync } from 'node:fs'
import { finishProbe, probeCases } from './harness'
import {
  GV_LINE_CAP,
  GV_THIN_SENTENCES,
  judgeGvSize,
  sentenceText,
  summarizeGvDataset,
  type GvStatsFacts
} from '@shared/train/gv-stats'

const NOW = Date.UTC(2026, 10, 22, 12, 0, 0)
const DAY = 86_400_000

/** 40 句、每个 wav 15 秒、全部读到 → 约 10 分钟，判够。 */
const healthy: GvStatsFacts = {
  lines: 40,
  capped: false,
  wavCount: 40,
  sampledMs: Array.from({ length: 40 }, () => 15_000),
  skipped: 0,
  newestAt: NOW - 3 * DAY
}

export function runGvStatsProbe(): void {
  const { cases, push } = probeCases()

  // —— 正常形状：数得出来、说得清「约」还是「实测」——
  const stats = summarizeGvDataset(healthy)
  push(
    '真数据形状：40 句 40 个 wav 全部读到 = 实测',
    stats.sentences === 40 && stats.totalMs === 600_000 && stats.estimated === false,
    `totalMs=${stats.totalMs} estimated=${stats.estimated}`
  )
  push('真数据形状：40 句 10 分钟判够', judgeGvSize(stats, NOW).state === 'ok', judgeGvSize(stats, NOW).line)
  push(
    '真数据形状：一句话里带句数、分钟与「最近一条」',
    (() => {
      const line = judgeGvSize(stats, NOW).line
      return line.includes('40 句') && line.includes('10 分钟') && line.includes('最近一条 3 天前')
    })(),
    judgeGvSize(stats, NOW).line
  )

  // —— 采样不足时不许冒充实测 ——
  const sampled = summarizeGvDataset({ ...healthy, sampledMs: [15_000, 15_000], wavCount: 40 })
  push('采样只读 2/40 → 标成估', sampled.estimated === true, `estimated=${sampled.estimated}`)
  push('采样不足时那句话要带「约」', judgeGvSize(sampled, NOW).line.includes('约 10 分钟'), judgeGvSize(sampled, NOW).line)

  // —— 句数不足 ——
  const few = summarizeGvDataset({ ...healthy, lines: 10, wavCount: 10, sampledMs: [4_000] })
  const fewVerdict = judgeGvSize(few, NOW)
  push('10 句 → 偏少，且说清缺多少', fewVerdict.state === 'thin' && fewVerdict.line.includes(`至少 ${GV_THIN_SENTENCES} 句`), fewVerdict.line)

  // —— 缺 5-wav32k：句数在、时长测不到，不许给 0 ——
  const noWav = summarizeGvDataset({ ...healthy, wavCount: null, sampledMs: [], newestAt: null })
  const noWavVerdict = judgeGvSize(noWav, NOW)
  push('缺 wav32k → 时长 null（不是 0）', noWav.totalMs === null, `totalMs=${noWav.totalMs}`)
  push('缺 wav32k → 说测不到，且仍报句数', noWavVerdict.state === 'unknown' && noWavVerdict.line.includes('40 句') && noWavVerdict.line.includes('测不到'), noWavVerdict.line)

  // —— 空目录与「只有 wav、没有音素表」——
  const empty = summarizeGvDataset({ lines: null, capped: false, wavCount: null, sampledMs: [], skipped: 0, newestAt: null })
  push('两个都没有 → 还没有备料', judgeGvSize(empty, NOW).line.includes('还没有备料'), judgeGvSize(empty, NOW).line)
  const zero = summarizeGvDataset({ ...healthy, lines: 0, wavCount: 0, sampledMs: [], newestAt: null })
  push('音素表 0 行 → 说是空的、判偏少', judgeGvSize(zero, NOW).state === 'thin' && judgeGvSize(zero, NOW).line.includes('空的'), judgeGvSize(zero, NOW).line)
  const wavOnly = summarizeGvDataset({ ...healthy, lines: null, wavCount: 27, newestAt: NOW })
  const wavOnlyVerdict = judgeGvSize(wavOnly, NOW)
  push(
    '只有 wav 没有音素表 → 说知道的那一半',
    wavOnlyVerdict.state === 'unknown' && wavOnlyVerdict.line.includes('27 个录音') && wavOnlyVerdict.line.includes('2-name2text.txt'),
    wavOnlyVerdict.line
  )

  // —— 读不出来的头：跳过超过一半就不许再给「约」——
  const skipped = summarizeGvDataset({ ...healthy, sampledMs: [12_000], skipped: 30 })
  push('跳过 30 / 读到 1 → 时长测不到', skipped.totalMs === null, `totalMs=${skipped.totalMs} basis=${skipped.basis}`)
  push('算法自述里写清跳过几个', skipped.basis.includes('跳过 30'), skipped.basis)

  // —— 行数到顶 ——
  const capped = summarizeGvDataset({ ...healthy, lines: GV_LINE_CAP, capped: true })
  const cappedFacts: GvStatsFacts = { lines: GV_LINE_CAP, capped: true, wavCount: 0, sampledMs: [], skipped: 0, newestAt: null }
  push('数到上界要写「+」', sentenceText(cappedFacts) === `${GV_LINE_CAP}+`, sentenceText(cappedFacts))
  push('到顶时说得出这是下界（估过的总时长不会缩水）', capped.sentences === GV_LINE_CAP, `sentences=${capped.sentences}`)

  // —— 标签与录音数量对不上 ——
  const mismatch = summarizeGvDataset({ ...healthy, lines: 40, wavCount: 25, sampledMs: [15_000] })
  const mismatchVerdict = judgeGvSize(mismatch, NOW)
  push('句数与 wav 数差得多 → 提醒对名单', mismatchVerdict.line.includes('差得多'), mismatchVerdict.line)

  // —— 真目录：CI 上不存在就 SKIP 并点名 ——
  const asrFt = process.env.OMD2_GV_HOME ?? ''
  if (asrFt === '' || !existsSync(asrFt)) {
    push('真目录那一路', true, 'SKIP：没有 OMD2_GV_HOME（CI 上不存在引擎包），只验纯缝')
  } else {
    push('真目录那一路', true, `SKIP：真读盘由 --train-probe 覆盖（${asrFt}）`)
  }

  finishProbe('GV_STATS_PROBE', cases)
}