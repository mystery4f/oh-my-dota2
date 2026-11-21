/**
 * 语音切段策略（#85）：同一句话，两种切法。
 *
 * - `punctuation`：只是在标点处切，长短跟着句子走。自然，但一段可能很长（Edge 每段一次跨境往返）。
 * - `uniform`：按固定字数切，忽略标点。段长均匀、起播更可预测，代价是可能断在词中间。
 *
 * 两条策略都遵守一条铁律：**切完拼回来必须与原文逐字相同**（探针断言）。丢一个标点、
 * 少一个汉字，用户听到的就是另一句话。
 *
 * 面板的「试切」与管线里的真实切法共用这一个函数——两块各写一遍，预览就会撒谎。
 */
export type SpeechSplitStrategy = 'punctuation' | 'uniform'

export const SPEECH_SPLIT_STRATEGIES: readonly SpeechSplitStrategy[] = ['punctuation', 'uniform']

export const SPEECH_SPLIT_LABELS: Record<SpeechSplitStrategy, string> = {
  punctuation: '按标点切（默认）',
  uniform: '按字数切'
}

export const SPEECH_SPLIT_HINTS: Record<SpeechSplitStrategy, string> = {
  punctuation: '在逗号句号处断开；一段可能偏长，长句要等更久才出声',
  uniform: '每段字数一样多；起播更均匀，但可能断在词中间'
}

/** 每段字数上限的允许区间（与设置里的 `speechSegmentChars` 同源）。 */
export const SEGMENT_CHARS_MIN = 10
export const SEGMENT_CHARS_MAX = 60
export const SEGMENT_CHARS_DEFAULT = 30

export function normalizeSplitStrategy(raw: unknown): SpeechSplitStrategy {
  return raw === 'uniform' ? 'uniform' : 'punctuation'
}

export function clampSegmentChars(raw: unknown): number {
  const value = typeof raw === 'number' && Number.isFinite(raw) ? Math.round(raw) : SEGMENT_CHARS_DEFAULT
  if (value < SEGMENT_CHARS_MIN) return SEGMENT_CHARS_MIN
  if (value > SEGMENT_CHARS_MAX) return SEGMENT_CHARS_MAX
  return value
}

const BREAK = '，。！？；、,!?;'

/**
 * 切段。`punctuation` 与改动前逐字等价（老字符串拼回来一样），
 * `uniform` 只在超过上限时才开始按固定长度切。
 */
export function splitForSpeech(
  text: string,
  maxChars = SEGMENT_CHARS_DEFAULT,
  strategy: SpeechSplitStrategy = 'punctuation'
): string[] {
  const raw = text.trim()
  if (raw === '') return []
  const limit = clampSegmentChars(maxChars)
  if (raw.length <= limit) return [raw]
  return strategy === 'uniform' ? splitUniform(raw, limit) : splitAtPunctuation(raw, limit)
}

/** 按标点切：标点跟着前一段走，拼回来才不丢符号；超长段再硬切。 */
function splitAtPunctuation(raw: string, maxChars: number): string[] {
  const parts = raw.match(new RegExp(`[^${BREAK}]+[${BREAK}]?`, 'gu')) ?? [raw]
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
  return pieces.flatMap((piece) => hardCut(piece, maxChars))
}

/** 按固定字数切：不看标点，段长整齐，代价是可能断在词中间。 */
function splitUniform(raw: string, maxChars: number): string[] {
  const out: string[] = []
  for (let index = 0; index < raw.length; index += maxChars) out.push(raw.slice(index, index + maxChars))
  return out
}

function hardCut(piece: string, maxChars: number): string[] {
  if (piece.length <= maxChars) return [piece]
  const out: string[] = []
  for (let index = 0; index < piece.length; index += maxChars) out.push(piece.slice(index, index + maxChars))
  return out
}

export interface SpeechSplitPreview {
  strategy: SpeechSplitStrategy
  maxChars: number
  segments: string[]
  /** 拼回来的文本；与输入不等就是切法丢字了，面板要把这件事说出来 */
  joined: string
  lossless: boolean
}

export function previewSplit(
  text: string,
  strategy: SpeechSplitStrategy,
  maxChars = SEGMENT_CHARS_DEFAULT
): SpeechSplitPreview {
  const segments = splitForSpeech(text, maxChars, strategy)
  const joined = segments.join('')
  return {
    strategy,
    maxChars: clampSegmentChars(maxChars),
    segments,
    joined,
    lossless: joined === text.trim()
  }
}

/** 面板那一行：「3 段 · 每段最多 14 字 · 「…」｜「…」」。 */
export function splitPreviewLine(preview: SpeechSplitPreview): string {
  if (preview.segments.length === 0) return '这句话切不出段（空的）'
  const longest = preview.segments.reduce((max, one) => Math.max(max, one.length), 0)
  const head = `${preview.segments.length} 段 · 最长 ${longest} 字`
  const shown = preview.segments.slice(0, 3).map((one) => `「${one}」`).join('｜')
  const more = preview.segments.length > 3 ? ` …共 ${preview.segments.length} 段` : ''
  return preview.lossless ? `${head}：${shown}${more}` : `${head}：拼回来与原文不一致，这个切法会丢字`
}

/** 面板「试切」用的一句话：够长、带中文标点。 */
export const SPLIT_SAMPLE = '对面幽鬼在偷塔了，先回去守一波，我在这儿等大招。'