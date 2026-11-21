/**
 * #98 探针：改过再送。
 *
 * 票面验收：
 * - `Edited text is what gets translated and spoken` → `reviewOf` 交付改过那一版，`voiceReply`
 *   用 `review.text` 去翻译（`text` 就是送出去的），这条断言钉住「哪一版」；
 * - `the pair lands in the correction set` → 只有真改过才给出 `pair`，`voiceReply` 拿它调
 *   `noteCorrection(before, after)`（纠错集的唯一入口）；
 * - `an unedited line behaves exactly as today` → 未编辑（或改回原样）时 `text` 等于原文、
 *   `pair === null`，`VOICE_REVIEW` 一个字都不写。
 */
import { reviewLine, reviewOf } from '@shared/voice-review'
import { finishProbe, probeCases } from './harness'

export async function runVoiceReviewProbe(): Promise<void> {
  const { cases, push } = probeCases()

  // —— 验收一：改过就用改过的 ——
  const edited = reviewOf({ transcript: '推开中路', edited: '推中路 快' })
  push('改过：送出的是改过那一版', edited.text === '推中路 快' && edited.edited === true, edited.text)
  push('改过：纠错对是 原文→改文', edited.pair !== null && edited.pair.before === '推开中路' && edited.pair.after === '推中路 快', JSON.stringify(edited.pair))

  // —— 验收三：未编辑的行与今天一模一样 ——
  const untouched = reviewOf({ transcript: 'care mid' })
  push('未编辑：原样送出、不记纠错', untouched.text === 'care mid' && untouched.edited === false && untouched.pair === null)
  const noop = reviewOf({ transcript: 'care mid', edited: '  care mid  ' })
  push('改回原样（含空白差异）：不算改过', noop.text === 'care mid' && noop.edited === false && noop.pair === null)
  const cleared = reviewOf({ transcript: 'care mid', edited: '   ' })
  push('清空不当改：回落原文，不记纠错', cleared.text === 'care mid' && cleared.edited === false && cleared.pair === null)

  // —— 边界 ——
  push('识别为空、人写了一句：按人写的送', reviewOf({ transcript: '', edited: 'need ward' }).text === 'need ward')
  push('两边都空：空串，链上会走 empty-recognition', reviewOf({ transcript: '', edited: '' }).text === '')
  push('只有大小写不同也算改过（人不认大小写，翻译会）', reviewOf({ transcript: 'care Mid', edited: 'care mid' }).edited === true)

  // —— 文案 ——
  push('改过才有那句提示', reviewLine(edited) !== '' && reviewLine(untouched) === '', reviewLine(edited))

  finishProbe('VOICE_REVIEW_PROBE', cases)
}