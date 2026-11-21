/**
 * #92 长句加速的探针。
 *
 * 票面验收两句：`a long line uses the faster rate and stays intelligible in the rendered output;
 * short lines keep the user rate`。可懂度的部分由速率上限与引擎边界合起来兜住——这里逐条钉住边界，
 * 免得某次调参把上限推到引擎不接受、或人耳听不清的地方。
 */
import {
  LONG_LINE_CHARS,
  SPEECH_RATE_MAX,
  SPEECH_RATE_MIN,
  clampRate,
  rateDeltaLine,
  rateForLine,
  spokenChars
} from '@shared/speech-rate'
import { finishProbe, probeCases } from './harness'

export async function runSpeechRateProbe(): Promise<void> {
  const { cases, push } = probeCases()
  const short = 'push mid'
  const long = '我们要先推中路二塔然后马上转下路拿肉山，别在野区跟他们打'.repeat(2)
  const longer = long + long

  push('短句原样用用户速率（不被顺手四舍五入）', rateForLine({ text: short, baseRate: 0.98 }) === 0.98)
  push('恰好等于阈值也不算长句', rateForLine({ text: 'あ'.repeat(LONG_LINE_CHARS), baseRate: 1 }) === 1)
  const longRate = rateForLine({ text: long, baseRate: 1 })
  push('长句确实更快，且看得见的加速量', longRate > 1 && longRate <= SPEECH_RATE_MAX, `rate=${longRate}`)
  const longerRate = rateForLine({ text: longer, baseRate: 1 })
  push('越长的句子加速越多（到上限为止）', longerRate >= longRate && longerRate <= SPEECH_RATE_MAX, `${longRate} → ${longerRate}`)
  push(
    '加速吃满后不再随长度上涨',
    rateForLine({ text: long.repeat(20), baseRate: 1 }) === 1.18,
    String(rateForLine({ text: long.repeat(20), baseRate: 1 }))
  )
  push(
    '用户已经选了快速率：长句不会越界',
    rateForLine({ text: long, baseRate: SPEECH_RATE_MAX }) === SPEECH_RATE_MAX
  )
  push(
    '用户选了慢速率：短句一个字不差',
    rateForLine({ text: 'short line', baseRate: 0.6 }) === 0.6
  )
  push(
    '慢速率下的长句仍是「相对变快、绝对合规」',
    rateForLine({ text: long, baseRate: 0.6 }) > 0.6 && rateForLine({ text: long, baseRate: 0.6 }) <= SPEECH_RATE_MAX
  )
  push('标点与空白不算长度', spokenChars('  。，！？？… \n\t ') === 0 && spokenChars('中 文，标点。') === 4)
  push('只数发音字符：英文单词跟着字母数', spokenChars('push mid now') === 10, String(spokenChars('push mid now')))
  push('非法输入不产生非法速率', Number.isFinite(rateForLine({ text: short, baseRate: Number.NaN })))
  push(
    '夹的两端就是引擎边界',
    clampRate(9) === SPEECH_RATE_MAX && clampRate(0.05) === SPEECH_RATE_MIN,
    `${clampRate(9)} / ${clampRate(0.05)}`
  )
  push('加速会说清加速了多少', (rateDeltaLine(long, 1, longRate) ?? '').includes('语速 1 →'))
  push('没加速就什么都不说（日志不糊）', rateDeltaLine(short, 1, 1) === null)

  finishProbe('SPEECH_RATE_PROBE', cases)
}
