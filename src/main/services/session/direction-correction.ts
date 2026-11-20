import { errorMessage } from '@shared/errors'
import type { DirectionCorrection, DirectionCorrectionResult } from '@shared/ipc'
import { correctDirection, directionFor } from '@shared/translate-direction'
import { loadSettings } from '../settings'
import { translateLines } from '../session/durable-translator'

/**
 * 方向更正（#84）：浮层上点一下方向标，就改判「这一句」并记住，然后按新方向重翻这一句。
 *
 * 重翻只是顺手把结果拿回来给浮层替换那一行 —— 真的花了模型往返才让人看见更正的效果。
 * 更正本身先记，翻不成也不回滚：用户的判断比模型的可用性更值得保留。
 */
export async function correctLineDirection(request: DirectionCorrection): Promise<DirectionCorrectionResult> {
  const text = String(request.text ?? '')
  const direction = request.direction === 'zh-en' ? 'zh-en' : 'en-zh'
  correctDirection(text, direction)
  console.log('TRANSLATE_DIRECTION_CORRECT', JSON.stringify({ direction, line: text.slice(0, 80) }))
  if (text.trim().length === 0) return { ok: true, direction, translated: null }
  try {
    const [translated] = await translateLines(loadSettings().provider, [text], directionFor(text), {
      origin: 'capture'
    })
    return { ok: translated !== undefined && translated !== null, direction, translated: translated ?? null }
  } catch (err) {
    return { ok: false, direction, translated: null, error: errorMessage(err) }
  }
}
