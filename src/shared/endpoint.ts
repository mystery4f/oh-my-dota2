/**
 * #97：停口判定（endpointing）。
 *
 * 现在录音只有两种结束方式：按住松开、或者再敲一下热键。慢句子的人说到一半换口气，
 * 手还按着——本该分成的两句被录成一句；短促的呼叫则要人一直按着。
 * 这里只做一件事：**说话人自己静下来够久，就当这一句说完了**。
 *
 * 两条硬规则：
 * - 太短不算：开头那一下气声、键盘声、一声叹气都不会整除成一句。累计有声不足
 *   `ENDPOINT_MIN_VOICED_MS` 之前，沉默多久都不收；
 * - 窗口是**可换**的：`short` 给短促呼叫（「推」「撤」「没蓝」），`slow` 给慢句子。
 *   每次开麦现读设置，改完立刻生效，不需要重启。
 */

export type SilencePreset = 'short' | 'slow'

/** 两个预设各自要静多久才算说完（毫秒）。 */
export const SILENCE_PRESETS: Record<SilencePreset, number> = {
  short: 700,
  slow: 1400
}

/** 累计有声不足这么久，沉默再久也不收：气声与杂音不该凑成一句。 */
export const ENDPOINT_MIN_VOICED_MS = 300

/** 设置里存的是字符串，坏值一律当 `short`（宁可早点收，也不要录出十分钟的空录音）。 */
export function presetOf(value: unknown): SilencePreset {
  return value === 'slow' ? 'slow' : 'short'
}

/** 这个预设的沉默窗口毫秒数。 */
export function presetWindowMs(value: unknown): number {
  return SILENCE_PRESETS[presetOf(value)]
}

export interface EndpointInput {
  /** 这一句里累计的有声时长（毫秒）。 */
  voicedMs: number
  /** 当前这段连续沉默的时长（毫秒）。 */
  silentMs: number
  /** 窗口（毫秒），来自预设。 */
  windowMs: number
}

export interface EndpointVerdict {
  /** 该收了吗。 */
  end: boolean
  /** 收的原因；没收时为 null。 */
  reason: 'silence' | null
}

/** 该不该把这一句收掉。 */
export function judgeUtteranceEnd(input: EndpointInput): EndpointVerdict {
  const windowMs = Number.isFinite(input.windowMs) && input.windowMs > 0 ? input.windowMs : SILENCE_PRESETS.short
  const voiced = Number.isFinite(input.voicedMs) ? input.voicedMs : 0
  const silent = Number.isFinite(input.silentMs) ? input.silentMs : 0
  if (voiced < ENDPOINT_MIN_VOICED_MS) return { end: false, reason: null }
  return silent >= windowMs ? { end: true, reason: 'silence' } : { end: false, reason: null }
}

/** 给人看的一句：开麦日志与提示共用这一份措辞。 */
export function endpointLine(value: unknown): string {
  const preset = presetOf(value)
  return preset === 'slow' ? '说完会等一会儿（慢句子）' : '说完就收（短促呼叫）'
}
