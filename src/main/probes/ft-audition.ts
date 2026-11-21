import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finishProbe, probeCases } from './harness'
import {
  AUDITION_MAX_ROWS,
  auditionLine,
  auditionRows,
  auditionSkipLine,
  judgeAudition,
  type AuditionPair
} from '@shared/train/audition'
import { buildTrainRun, finishTrainRun } from '@shared/train/run'
import type { FtLedgerEntry } from '@shared/train/asr-ft'
import { auditionEntriesOf, collectAuditionPairs, type AuditionTranscribe } from '../services/train/audition'

/**
 * 试听对比（#105）的验收探针。
 *
 * 票面三条验收，逐条对应：
 * - 两副模型看到同一批录音：注入的假转写记下每次 (side, wavPath)，断言两侧的 wav 序列逐项相同；
 * - 跑完之后有对比：judgeAudition 给出逐句胜负与整批 CER，verdict 与数字同向；
 * - 跳过是显式动作且记在 run 行上：finishTrainRun 合并 auditionSkip，默认仍是 null。
 * 另外钉住：识别成空串按全错算且不丢句、表格按「有差异优先」截断到 AUDITION_MAX_ROWS、
 * 两句文案都不出现「准确率」这类没有分母的说法。
 */
export async function runFtAuditionProbe(): Promise<void> {
  const { cases, push } = probeCases()
  const dir = mkdtempSync(join(tmpdir(), 'ft-audition-'))
  try {
    const wavOf = (key: string): string => join(dir, `${key}.wav`)
    const ledger: FtLedgerEntry[] = [
      { key: 'G14-L01', wavPath: wavOf('G14-L01'), bytes: 100, mtimeMs: 1, text: '中路不见了', split: 'eval' },
      { key: 'G14-L02', wavPath: wavOf('G14-L02'), bytes: 100, mtimeMs: 1, text: '肉山要打了', split: 'eval' },
      { key: 'G14-L03', wavPath: wavOf('G14-L03'), bytes: 100, mtimeMs: 1, text: '   ', split: 'eval' },
      { key: 'G14-L04', wavPath: wavOf('G14-L04'), bytes: 100, mtimeMs: 1, text: '上路要人来', split: 'train' },
      { key: 'G14-L05', wavPath: wavOf('G14-L05'), bytes: 100, mtimeMs: 1, text: '买活', split: 'eval' }
    ]
    for (const key of ['G14-L01', 'G14-L02', 'G14-L04']) writeFileSync(wavOf(key), 'RIFF')
    // G14-L03 文本是空白、G14-L05 文件不存在：两条都该被 auditionEntriesOf 淘汰。

    // —— 验收一：两副模型看到同一批录音 ——
    const seen: Array<{ side: string; wav: string }> = []
    const fake: AuditionTranscribe = async (modelDir, wavPath) => {
      seen.push({ side: modelDir.includes('next') ? 'after' : 'before', wav: wavPath })
      const mine = wavPath.includes('L02') ? '肉山要打了' : '中路不见了'
      return modelDir.includes('next') ? mine : mine.slice(0, -1)
    }
    const entries = auditionEntriesOf(ledger)
    push(
      '留出集只挑 eval + 有稿子 + 文件在的句子',
      entries.length === 2 && entries.map((entry) => entry.key).join(',') === 'G14-L01,G14-L02',
      `实际 ${entries.map((entry) => entry.key).join(',') || '（空）'}`
    )
    const pairs = await collectAuditionPairs(entries, { before: join(dir, 'model'), after: join(dir, 'next') }, fake)
    const beforeWavs = seen.filter((row) => row.side === 'before').map((row) => row.wav)
    const afterWavs = seen.filter((row) => row.side === 'after').map((row) => row.wav)
    push(
      '两副模型听到的是同一条 wav 序列（逐项相同）',
      beforeWavs.length === entries.length && beforeWavs.join('|') === afterWavs.join('|'),
      `before=${beforeWavs.length} after=${afterWavs.length}`
    )
    push(
      '每句都留了记录，空识别不算丢句',
      pairs.length === entries.length && pairs.every((pair) => pair.expected.trim() !== ''),
      `pairs=${pairs.length}`
    )

    // —— 验收二：跑完就有并排结论 ——
    const audition = judgeAudition(pairs, 1_700_000_000_000)
    push(
      '整批 CER 与 verdict 同向（新模型少错就是 better）',
      audition.beforeCer > audition.afterCer && audition.verdict === 'better',
      `before=${audition.beforeCer.toFixed(3)} after=${audition.afterCer.toFixed(3)} verdict=${audition.verdict}`
    )
    push(
      '逐句胜负与 CER 对得上',
      audition.rows.every((row) =>
        row.beforeCer === row.afterCer ? row.better === 'same' : row.afterCer < row.beforeCer === (row.better === 'after')
      ),
      JSON.stringify(audition.rows.map((row) => [row.key, row.better]))
    )
    push(
      '句数统计覆盖全部试听句（rows 可截断）',
      audition.count === pairs.length && audition.better + audition.worse + audition.same === pairs.length,
      `count=${audition.count}`
    )

    // —— 一句全错、一句全对：空串按全错算 ——
    const emptyPair: AuditionPair[] = [{ key: 'G14-L09', expected: '撤退', before: '', after: '撤退' }]
    const emptyAudition = judgeAudition(emptyPair, 1)
    push(
      '识别成空串按全错算，不会被当成「一样」',
      emptyAudition.rows[0].beforeCer === 1 && emptyAudition.rows[0].better === 'after' && emptyAudition.worse === 0,
      JSON.stringify(emptyAudition.rows[0])
    )

    // —— 表格截断：有差异的句子优先上桌 ——
    const many: AuditionPair[] = Array.from({ length: AUDITION_MAX_ROWS + 4 }, (_unused, index) => ({
      key: `G14-L${String(index + 10)}`,
      expected: '好',
      before: index === AUDITION_MAX_ROWS + 3 ? '坏' : '好',
      after: '好'
    }))
    const capped = judgeAudition(many, 1)
    push(
      `表格截断到 ${AUDITION_MAX_ROWS} 行，且有差异的那句一定在`,
      capped.rows.length === AUDITION_MAX_ROWS &&
        capped.rows.some((row) => row.key === `G14-L${AUDITION_MAX_ROWS + 13}` && row.better !== 'same'),
      `rows=${capped.rows.length} keys=${capped.rows.map((row) => row.key + ":" + row.better).join(",")}`
    )

    // —— 文案：不带没有分母的百分比，跳过要说清是谁点的 ——
    push(
      '对比一句话带句数与两边 CER，且不出现「准确率」',
      auditionLine(audition).includes(`${audition.count} 句`) &&
        auditionLine(audition).includes('CER') &&
        !auditionLine(audition).includes('准确率'),
      auditionLine(audition)
    )
    push(
      '自动跳过与人点的跳过说法不同',
      auditionSkipLine({ at: 1, auto: true, reason: '没有留出集可听' }).startsWith('自动跳过') &&
        auditionSkipLine({ at: 1, auto: false, reason: '' }) === '跳过试听',
      auditionSkipLine({ at: 1, auto: true, reason: '没有留出集可听' })
    )

    // —— 验收三：跳过记在 run 行上，默认不写 ——
    const run = buildTrainRun({ kind: 'asr-ft', experiment: 'ft-test', startedAt: 1_700_000_000_000 })
    push(
      '新 run 默认没有 audition / auditionSkip',
      run.audition === null && run.auditionSkip === null,
      JSON.stringify({ audition: run.audition, auditionSkip: run.auditionSkip })
    )
    const withAudition = finishTrainRun(run, { status: 'trained', audition })
    push(
      '试听结论落得进 run 行，不动 applied',
      withAudition.audition?.count === audition.count && withAudition.applied === false,
      `count=${withAudition.audition?.count ?? 'null'}`
    )
    const skipped = finishTrainRun(withAudition, {
      status: 'trained',
      auditionSkip: { at: 1_700_000_100_000, auto: false, reason: '' }
    })
    push(
      '显式跳过记在 run 行上，且不抹掉已有结论',
      skipped.auditionSkip?.auto === false && skipped.audition?.count === audition.count,
      JSON.stringify({ skip: skipped.auditionSkip, count: skipped.audition?.count })
    )
    push(
      '不传 audition 的收场不覆盖已记下的结论',
      finishTrainRun(skipped, { status: 'applied', applied: true }).audition?.count === audition.count,
      'expect keep'
    )

    // —— 纯计算只认输入：同样输入同样输出 ——
    const rowsAgain = auditionRows(pairs)
    push(
      'auditionRows 幂等：同样输入两次结果一致',
      JSON.stringify(rowsAgain) === JSON.stringify(auditionRows(pairs)),
      'expect stable'
    )
    push(
      '单句判定的边界：改一个字 CER 抬高、但不如全错',
      (() => {
        const one = judgeAudition([{ key: 'k', expected: '中路不见了', before: '中路不见', after: '中路不见了' }], 1)
        return one.beforeCer > 0 && one.beforeCer < 1 && one.better === 1
      })(),
      'expect 0<cer<1'
    )
    push(
      '全部一样时 verdict=same、两档 CER 相等',
      (() => {
        const flat = judgeAudition([{ key: 'k', expected: '撤退', before: '撤退', after: '撤退' }], 1)
        return flat.verdict === 'same' && flat.beforeCer === flat.afterCer && flat.same === 1
      })(),
      'expect same'
    )
    push(
      '没有留出集时一句都不试听，文案老实说没有',
      (() => {
        const none = judgeAudition([], 1)
        return none.count === 0 && auditionLine(none).includes('没试听')
      })(),
      'expect empty'
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
  finishProbe('FT_AUDITION_PROBE', cases)
}