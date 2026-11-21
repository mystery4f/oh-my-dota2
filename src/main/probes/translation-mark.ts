/**
 * --translation-mark-probe：对局里标「这句译得好/差」的那套账（#87）。
 *
 * 钉的是口径而不是 UI：
 * - 没翻出来的行不能被标记（不然攒一堆空样本，好评率是假的）；
 * - 同一行先标「差」再改判「好」，只算一条、算最后那条；
 * - 分组按（供应商 × 模型）算，好评率高的在前、同率样本多的在前；
 * - 0 条时那句话说的是「还没标过」，不是「全部译得对」；
 * - 热键的反馈永远是句话（标不上也要说为什么），没有静默分支。
 */
import { join } from 'node:path'
import { logsDir } from '../services/logs/base-dir'
import { translationMarksPath } from '../services/session/translation-marks'
import {
  buildMark,
  dedupeMarks,
  markFeedback,
  markKey,
  marksLine,
  summarizeMarks,
  type TranslationMark
} from '@shared/translation-mark'
import { exitProbe, finishProbe, probeCases } from './harness'

export function runTranslationMarkProbe(): void {
  const { cases, push } = probeCases()
  const TAG = 'TRANSLATION_MARK_PROBE'

  const base = {
    at: '2026-11-21T12:00:00.000Z',
    matchid: '7512345678',
    verdict: 'good' as const,
    provider: 'deepseek',
    model: 'deepseek-chat'
  }

  function entry(id: string, body: string, translated: string | null, cached = false) {
    return { id, body, translated, cached }
  }

  const ok = buildMark({ ...base, entry: entry('e1', '他中路不见了', 'Mid is missing.') })
  push(
    '正常的行记成一条完整样本',
    ok !== null &&
      ok.entryId === 'e1' &&
      ok.source === '他中路不见了' &&
      ok.translation === 'Mid is missing.' &&
      ok.matchid === '7512345678' &&
      ok.cached === false,
    ok === null ? 'null' : `${ok.provider}/${ok.model} ${ok.verdict}`
  )

  push(
    '没译文 / 空原文 / 空译文都不成样本',
    buildMark({ ...base, entry: entry('e2', '我们开雾', null) }) === null &&
      buildMark({ ...base, entry: entry('e3', '   ', 'We smoke.') }) === null &&
      buildMark({ ...base, entry: entry('e4', '打肉山', '   ') }) === null,
    '三条都被拒'
  )

  const cachedMark = buildMark({ ...base, entry: entry('e5', '打肉山', 'Roshan now.', true) })
  push(
    '记账本直给的译文会标 cached',
    cachedMark !== null && cachedMark.cached === true,
    String(cachedMark?.cached)
  )

  const first = buildMark({
    ...base,
    entry: entry('dup', '他中路不见了', 'Mid is missing.')
  }) as TranslationMark
  const second = buildMark({
    ...base,
    verdict: 'bad',
    at: '2026-11-21T12:05:00.000Z',
    entry: entry('dup', '他中路不见了', 'Mid missing.')
  }) as TranslationMark
  const other = buildMark({
    ...base,
    entry: entry('other', '我们开雾', 'We smoke.')
  }) as TranslationMark
  const deduped = dedupeMarks([first, other, second])
  push(
    '同一行改判只留最后一条，别行不受影响',
    deduped.length === 2 && deduped.find((mark) => markKey(mark) === 'dup')?.verdict === 'bad',
    deduped.map((mark) => `${markKey(mark)}:${mark.verdict}`).join(' ')
  )

  const summary = summarizeMarks([
    ok as TranslationMark,
    first,
    second,
    other,
    buildMark({
      ...base,
      matchid: null,
      provider: 'moonshot',
      model: 'kimi',
      entry: entry('e9', '打肉山', 'Roshan now.')
    }) as TranslationMark
  ])
  push(
    '总数按去重后算（重复的那条不重复计数：4 条里 3 好 1 差）',
    summary.total === 4 && summary.good === 3 && summary.bad === 1,
    `total ${summary.total} good ${summary.good} bad ${summary.bad}`
  )
  push(
    '分组按供应商 × 模型，好评率高的在前',
    summary.tallies.length === 2 &&
      summary.tallies[0].provider === 'moonshot' &&
      summary.tallies[1].provider === 'deepseek' &&
      Math.abs(summary.tallies[0].goodRate - 1) < 1e-9,
    summary.tallies.map((tally) => `${tally.provider} ${tally.good}/${tally.total}`).join(' · ')
  )
  push(
    '带不上 matchid 的样本单独计数，不是丢掉',
    summary.attributed === 3 && summary.total === 4,
    `${summary.attributed}/${summary.total} 归属`
  )

  push(
    '0 条时说的是「还没标过」，不是「全部译得对」',
    marksLine(summarizeMarks([])).includes('还没标过'),
    marksLine(summarizeMarks([]))
  )
  push(
    '有标记时那句话带百分比与样本数',
    marksLine(summary).includes('100%') && marksLine(summary).includes('4 条标记'),
    marksLine(summary)
  )

  push(
    '标不上时反馈说清原因，不静默',
    markFeedback('bad', null).includes('没有可标记的译文'),
    markFeedback('bad', null)
  )
  push(
    '标记成功的反馈带供应商与未归属提示',
    markFeedback('good', ok as TranslationMark).includes('已标记') &&
      markFeedback('good', ok as TranslationMark).includes('deepseek/deepseek-chat') &&
      markFeedback('good', ok as TranslationMark).includes('未归属') === false &&
      markFeedback(
        'good',
        buildMark({
          ...base,
          matchid: null,
          entry: entry('e8', '他中路不见了', 'Mid is missing.')
        }) as TranslationMark
      ).includes('未归属'),
    markFeedback('good', ok as TranslationMark)
  )

  push(
    '记录落在 logs 目录下的 translation-marks.jsonl（探针模式下是临时根）',
    translationMarksPath() === join(logsDir(), 'translation-marks.jsonl'),
    translationMarksPath()
  )

  finishProbe(TAG, cases, { summary, line: marksLine(summary) })
  exitProbe(
    cases.every((item) => item.ok),
    cases
  )
}
