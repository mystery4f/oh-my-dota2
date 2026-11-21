/**
 * 切段策略（#85）：两种切法的结果、拼回来是否逐字不差、以及面板「试切」那一行。
 *
 * 这一层的失败方式全是「听感不对」而不是报错：多切一段就多一次跨境往返（起播变慢），
 * 少切一段就是整句等一次往返；最坏的是切法丢标点，用户听到的是另一句话。三条都能断言。
 */
import { finishProbe, probeCases } from './harness'
import {
  SEGMENT_CHARS_DEFAULT,
  SEGMENT_CHARS_MAX,
  SEGMENT_CHARS_MIN,
  SPLIT_SAMPLE,
  clampSegmentChars,
  normalizeSplitStrategy,
  previewSplit,
  splitForSpeech,
  splitPreviewLine
} from '@shared/speech-split'
import { splitForSpeech as pipelineSplit } from '../services/voice/speech-pipeline'

const SAMPLE = '对面幽鬼在偷塔了，先回去守一波，我在这儿等大招。'

export function runSpeechSplitProbe(): void {
  const { cases, push } = probeCases()

  // —— 两条策略对同一句话给不同的切法，且都不丢字 ——
  const punctual = splitForSpeech(SAMPLE, 14, 'punctuation')
  const uniform = splitForSpeech(SAMPLE, 14, 'uniform')
  push('按标点切：段首落在标点后面', punctual.length >= 2, `${punctual.length} 段：${punctual.join(' | ')}`)
  push('按字数切：段长不超过上限', uniform.every((one) => one.length <= 14), uniform.join(' | '))
  push('两种切法结果不同（同一句、同一上限）', punctual.join('') !== uniform.join('') || punctual.length !== uniform.length)
  push('按标点切拼回来与原文逐字相同', punctual.join('') === SAMPLE, punctual.join(''))
  push('按字数切拼回来与原文逐字相同', uniform.join('') === SAMPLE, uniform.join(''))
  push('按字数切段长整齐（只最后一段可短）', uniform.slice(0, -1).every((one) => one.length === 14))

  // —— 短句不切、空串切出空 ——
  push('短于上限就是一段', splitForSpeech('好的', 30, 'punctuation').length === 1)
  push('空串切出空数组', splitForSpeech('   ', 30, 'uniform').length === 0)

  // —— 上限钳位与策略归一 ——
  push('上限下界钳到 10', clampSegmentChars(1) === SEGMENT_CHARS_MIN)
  push('上限上界钳到 60', clampSegmentChars(999) === SEGMENT_CHARS_MAX)
  push('坏值回默认 30', clampSegmentChars('garbage') === SEGMENT_CHARS_DEFAULT)
  push('未知策略回落按标点', normalizeSplitStrategy('whatever') === 'punctuation')
  push('uniform 原样保留', normalizeSplitStrategy('uniform') === 'uniform')

  // —— 面板「试切」与管线是同一份实现（否则预览会撒谎）——
  push(
    '面板试切与管线切法逐段相同',
    previewSplit(SPLIT_SAMPLE, 'uniform', 12).segments.join('|') === pipelineSplit(SPLIT_SAMPLE, 12, 'uniform').join('|'),
    previewSplit(SPLIT_SAMPLE, 'uniform', 12).segments.join(' | ')
  )
  push(
    '按标点时面板与管线也一致',
    previewSplit(SAMPLE, 'punctuation', 14).segments.join('|') === pipelineSplit(SAMPLE, 14, 'punctuation').join('|')
  )
  push('预览标明是否丢字', previewSplit(SAMPLE, 'punctuation', 14).lossless === true)

  // —— 那句话：说出段数与最长字，不丢字时才说段内容 ——
  const line = splitPreviewLine(previewSplit(SAMPLE, 'uniform', 12))
  push('试切那一行含段数', line.includes('段'), line)
  push('试切那一行含最长字数', /最长 \d+ 字/.test(line), line)
  push('空句子单独一句话', splitPreviewLine(previewSplit('   ', 'uniform', 12)).includes('空'))

  finishProbe('SPEECH_SPLIT_PROBE', cases, {
    punctuation: punctual.length,
    uniform: uniform.length,
    sample: SAMPLE
  })
}