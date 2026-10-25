/**
 * 长句切段：朗读用，把一句话切成若干小段，让第一段先出声。
 * 为什么不是排版问题：Edge 每段都要一次跨境往返（实测整句 0.7–1.6 s），
 * 一句话 40 个字等一次往返，听众会以为「朗读坏了」。按标点切成 ≤20 字的小段后，
 * 第一段先播，后面的段在播第一段时已经合成完成，听感上是连续的。
 * 只切标点，不动字面：切完拼回来必须和原文一模一样（探针会断言）。
 */
export function splitForSpeech(text: string, maxChars = 20): string[] {
  const raw = text.trim()
  if (!raw) return []
  if (raw.length <= maxChars) return [raw]
  // 标点跟着前一段走，拼回来才不会丢符号。
  const parts = raw.match(/[^，。！？；、,!?;]+[，。！？；、,!?;]?/gu) ?? [raw]
  const pieces: string[] = []
  let current = ''
  for (const part of parts) {
    if (current && current.length + part.length > maxChars) {
      pieces.push(current)
      current = part
    } else {
      current += part
    }
  }
  if (current) pieces.push(current)
  // 极端输入（一句 60 字不带标点）：硬切，宁可断在词中间也不要整句等一次往返。
  const out: string[] = []
  for (const piece of pieces) {
    if (piece.length <= maxChars) {
      out.push(piece)
      continue
    }
    for (let index = 0; index < piece.length; index += maxChars) out.push(piece.slice(index, index + maxChars))
  }
  return out
}
