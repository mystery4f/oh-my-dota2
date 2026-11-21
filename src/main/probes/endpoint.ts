/**
 * #97 探针：停口判定（endpointing）。
 *
 * 票面验收：
 * - `each preset cuts at its declared window` → `short` 在 700ms 沉默处收、699ms 处不收；
 *   `slow` 在 1400ms 处收、1399ms 处不收；
 * - `a preset change needs no restart` → 窗口是**每次判定的入参**，同一个纯函数换个窗口就换行为，
 *   进程里没有任何一处缓存旧值（渲染层每次开麦现读设置）。
 *
 * 另钉两条安全边界：有声不足 300ms 时沉默再久也不收（气声/键盘声不凑成一句）；
 * 坏预设值一律回落 `short`（宁可早收，也不要录出十分钟空录音）。
 */
import {
  ENDPOINT_MIN_VOICED_MS,
  SILENCE_PRESETS,
  endpointLine,
  judgeUtteranceEnd,
  presetOf,
  presetWindowMs
} from '@shared/endpoint'
import { finishProbe, probeCases } from './harness'

export async function runEndpointProbe(): Promise<void> {
  const { cases, push } = probeCases()

  // —— 验收一：每个预设在自己的窗口边界上切 ——
  for (const preset of ['short', 'slow'] as const) {
    const windowMs = SILENCE_PRESETS[preset]
    const before = judgeUtteranceEnd({ voicedMs: 900, silentMs: windowMs - 1, windowMs })
    const at = judgeUtteranceEnd({ voicedMs: 900, silentMs: windowMs, windowMs })
    push(
      `${preset} 预设：${windowMs}ms 处收，${windowMs - 1}ms 处不收`,
      before.end === false && at.end === true && at.reason === 'silence',
      `before=${before.end} at=${at.end} window=${windowMs}`
    )
  }
  push('两个预设确实不同（短呼叫先收）', SILENCE_PRESETS.short < SILENCE_PRESETS.slow, `${SILENCE_PRESETS.short} < ${SILENCE_PRESETS.slow}`)

  // —— 验收二：换预设立刻生效，不需要重启 ——
  const silent = 900
  const asShort = judgeUtteranceEnd({ voicedMs: 900, silentMs: silent, windowMs: presetWindowMs('short') })
  const asSlow = judgeUtteranceEnd({ voicedMs: 900, silentMs: silent, windowMs: presetWindowMs('slow') })
  push('同一段沉默：short 收、slow 不收（换档即生效）', asShort.end === true && asSlow.end === false, `short=${asShort.end} slow=${asSlow.end}`)
  push('设置值经 presetOf 归一：坏值回落 short', presetOf('slow') === 'slow' && presetOf('whatever') === 'short' && presetOf(undefined) === 'short')
  push('窗口毫秒数与预设一致', presetWindowMs('slow') === SILENCE_PRESETS.slow && presetWindowMs(42) === SILENCE_PRESETS.short)

  // —— 安全边界 ——
  push(
    `有声不足 ${ENDPOINT_MIN_VOICED_MS}ms：沉默再久也不收`,
    judgeUtteranceEnd({ voicedMs: ENDPOINT_MIN_VOICED_MS - 1, silentMs: 10_000, windowMs: SILENCE_PRESETS.short }).end === false
  )
  push('够一句的时长就按窗口收', judgeUtteranceEnd({ voicedMs: ENDPOINT_MIN_VOICED_MS, silentMs: SILENCE_PRESETS.short, windowMs: SILENCE_PRESETS.short }).end === true)
  push('窗口是坏值（0 / NaN）时按 short 兜底', judgeUtteranceEnd({ voicedMs: 900, silentMs: SILENCE_PRESETS.short, windowMs: 0 }).end === true && judgeUtteranceEnd({ voicedMs: 900, silentMs: SILENCE_PRESETS.short, windowMs: Number.NaN }).end === true)
  push('输入是 NaN 时当 0，不会误收', judgeUtteranceEnd({ voicedMs: Number.NaN, silentMs: 5000, windowMs: SILENCE_PRESETS.short }).end === false)

  // —— 文案 ——
  push('两档说得出区别', endpointLine('short') !== endpointLine('slow') && endpointLine('slow').includes('慢句子'), endpointLine('slow'))

  finishProbe('ENDPOINT_PROBE', cases)
}