/**
 * #119 探针：一局一张战绩图。
 *
 * 票面两条验收逐条钉住：
 * - `The image is generated from recorded numbers only` → 数字只来自 `voice-chain.jsonl` 的行，
 *   坏行跳过、`spoken` 缺省不算听懂、中位按记录算，图里的数字都能在记录里找到；
 * - `A match with no voice activity produces a report that says so` → 没有记录时图照样出，
 *   正文第一句是「这一局没有语音活动」。
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { matchReportLine, matchReportNumbers, matchReportOf, matchReportSvg } from '@shared/match-report'
import { matchIdFromSummary, parseMatchReportRows, writeMatchReport } from '../services/report/match-report'
import { finishProbe, probeCases } from './harness'

export async function runReportImageProbe(): Promise<void> {
  const { cases, push } = probeCases()

  const rows = [
    { spoken: true, firstAudioMs: 900, totalMs: 2600 },
    { spoken: true, firstAudioMs: 1100, totalMs: 3000 },
    { spoken: false, stage: 'mic', firstAudioMs: null, totalMs: null },
    { spoken: true, stage: 'voice-out', firstAudioMs: 1300, totalMs: 3400 },
  ]
  const numbers = matchReportNumbers(rows)
  push('听懂只数 spoken 为真的行', numbers.understood === 3, `understood=${numbers.understood}`)
  push('标出只数链路自己写下的失败 stage', numbers.flagged === 2, `flagged=${numbers.flagged}`)
  push('首音中位按记录算（900/1100/1300 → 1100）', numbers.firstAudioMs === 1100, String(numbers.firstAudioMs))
  push('整条中位按记录算（2600/3000/3400 → 3000）', numbers.totalMs === 3000, String(numbers.totalMs))

  const report = matchReportOf(rows, { matchId: '9100000003', generatedAt: '2026-11-21T11:00:00.000Z' })
  push('总结句写的是记录里的数字', report.headline === '听懂 3 句 · 标出 2 行', report.headline)
  const svg = matchReportSvg(report)
  push('图里画了听懂与标出的数字', svg.includes('听懂 3 句') && svg.includes('标出 2 行'))
  push('图里画了首音中位', svg.includes('首音中位 1100 ms'))
  push('图里写了数据来源，不写「估计」「约」', svg.includes('logs/voice-chain.jsonl') && !svg.includes('估计'))

  const empty = matchReportOf([], { matchId: '9100000004', generatedAt: '2026-11-21T11:00:00.000Z' })
  push('没有语音活动的对局，正文第一句就说没有', empty.headline === '这一局没有语音活动', empty.headline)
  push('空图数字全是 0，不编数', empty.understood === 0 && empty.flagged === 0 && empty.rows === 0)
  push('空图照样画得出来', matchReportSvg(empty).includes('这一局没有语音活动'))
  push('一行总结给面板复用', matchReportLine(empty).startsWith('这一局没有语音活动'))
  push('坏行跳过、好行留下', parseMatchReportRows('{"spoken":true}\nnot json\n{"spoken":false,"stage":"mic"}\n').length === 2)
  push('gsi 摘要里取对局号', matchIdFromSummary('{"map":{"matchid":"9100000005"}}') === '9100000005')
  push('摘要坏了写未知对局，不编 id', matchIdFromSummary('{"map":') === '' && matchReportOf(rows, { matchId: '' }).matchId === '未知对局')

  const dir = mkdtempSync(join(tmpdir(), 'omd-report-'))
  try {
    writeFileSync(join(dir, 'voice-chain.jsonl'), '{"spoken":true,"firstAudioMs":800,"totalMs":2100}\n{"spoken":false,"stage":"translate"}\n', 'utf8')
    writeFileSync(join(dir, 'gsi-summary.json'), '{"map":{"matchid":"9100000006"}}', 'utf8')
    const out = writeMatchReport({ dir, at: '2026-11-21T12:00:00.000Z' })
    push('落盘成功并按对局号命名', out.ok && out.path.endsWith('match-report-9100000006.svg'), out.path)
    push('落盘的图和纯函数画的一致', readFileSync(out.path, 'utf8') === matchReportSvg(out.report))
    push('落盘图里的数字来自这份记录', readFileSync(out.path, 'utf8').includes('听懂 1 句'), out.report.headline)

    const bare = mkdtempSync(join(tmpdir(), 'omd-report-empty-'))
    try {
      const none = writeMatchReport({ dir: bare, at: '2026-11-21T12:30:00.000Z' })
      push('没有记录的目录也出图，并写明没有语音活动', none.ok && readFileSync(none.path, 'utf8').includes('这一局没有语音活动'), none.path)
      push('没有对局号时文件名不剩一串短横', none.path.endsWith('match-report-unknown.svg'), none.path)
    } finally {
      rmSync(bare, { recursive: true, force: true })
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  finishProbe('REPORT_IMAGE_PROBE', cases)
}
