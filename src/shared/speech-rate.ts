/**
 * #92：长句自己快一点说，短句保持用户选的速率。
 *
 * 为什么是一张表而不是散在各处的判断：`settings.ttsRate` 是用户耳朵的偏好，句子长度是排队压力。
 * 两件事分开算，才有机会解释「为什么这句变快了」——一句话能挡住整条队列时，唯一可动的就是速率，
 * 而速率的上限只能有一份（引擎不接受的值等于合成失败，快到听不清的值等于白说）。
 *
 * 可懂度的边界不是拍脑袋：`SPEECH_RATE_MAX` 决定最快能快到哪，`SPEECH_RATE_MIN` 决定慢句不会被拖到
 * 变声，两者合起来夹一次，任何输入都不会落到引擎闹脾气的区间里。
 */

/** 引擎侧可接受的最快速率；超过它不是「更快」，是「合成不出来」。 */
export const SPEECH_RATE_MAX = 1.35

/** 引擎侧可接受的最慢速率。 */
export const SPEECH_RATE_MIN = 0.5

/** 从这里往后算「长句」：低于它的句子完全用用户速率。 */
export const LONG_LINE_CHARS = 48

/** 到 `2 × LONG_LINE_CHARS` 时长句把加速吃满，再长也不再加。 */
export const LONG_LINE_BOOST = 0.18

/** 只数会占发音时间的字符：空白、标点、表情都不该让句子显得长。 */
export function spokenChars(text: string): number {
  const stripped = text.replace(/[\s\p{P}\p{S}]/gu, '')
  return [...stripped].length
}

/**
 * 这一句该用多快的速率。
 *
 * - 短句：原样返回用户速率（不做任何取整，免得「我只调了 0.98 变成了 1」）。
 * - 长句：随超出阈值的比例线性加速，最多 `boost`，最后和引擎边界一起夹一次。
 */
export function rateForLine(input: {
  text: string
  baseRate: number
  thresholdChars?: number
  boost?: number
  maxRate?: number
}): number {
  const base = Number.isFinite(input.baseRate) ? input.baseRate : 1
  const threshold = input.thresholdChars ?? LONG_LINE_CHARS
  const boost = input.boost ?? LONG_LINE_BOOST
  const maxRate = input.maxRate ?? SPEECH_RATE_MAX
  const chars = spokenChars(input.text ?? '')
  if (chars <= threshold) return clampRate(base, maxRate)
  const excess = (chars - threshold) / Math.max(1, threshold)
  const grown = base + boost * Math.min(1, excess)
  return clampRate(Math.round(grown * 1000) / 1000, maxRate)
}

/** 夹一次：既不突破引擎上限，也不把用户的慢速偏好压得比引擎下限还低。 */
export function clampRate(rate: number, maxRate: number = SPEECH_RATE_MAX): number {
  const ceiling = Math.min(maxRate, SPEECH_RATE_MAX)
  if (!Number.isFinite(rate)) return 1
  return Math.max(SPEECH_RATE_MIN, Math.min(ceiling, rate))
}

/** 这一句比用户速率快了多少；没加速就是 null（日志与面板都靠它说话）。 */
export function rateDeltaLine(text: string, baseRate: number, rate: number): string | null {
  if (rate <= baseRate) return null
  const chars = spokenChars(text)
  return `长句 ${chars} 字：语速 ${baseRate} → ${rate}`
}
