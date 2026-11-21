/**
 * 子句流水（#71）：让「第一句先出声」不必等整段翻译完。
 *
 * 现状是串行：录音停 → 整句翻译 → 第一段合成。翻译是一次网络往返，
 * 整段越长越慢，而合成第一段其实只需要第一句翻译结果。这里把句子切成
 * 子句，先翻第一句并立即送出，其余子句的翻译同时发出、按原顺序排队朗读。
 *
 * 三条不许破的规矩：
 * - 交付顺序永远是子句原顺序，不按「谁先翻完」排；
 * - 某一句翻译失败只跳过它，后面的照常走，绝不回头重翻或换引擎；
 * - 关掉开关就只有一整句，行为和以前一模一样（这个开关默认关）。
 */

/** 切句符：中英文句读都给上——聊天框里两种标点混着出现。 */
const BREAK_CHARS = '。！？；…，、,.!?;:'
/** 切句后短于这个长度的碎片并进前一句，避免「嗯。」单独合成一次。 */
export const CLAUSE_MIN_CHARS = 4
/** 单句上限：太长会被 TTS 引擎自己再切，这里先切好，顺序才可控。 */
export const CLAUSE_MAX_CHARS = 40

/**
 * 按标点切子句：标点跟着前一段走（朗读时那口气不能丢），
 * 太短的碎片并入前一段，过长的子句按上限硬切，保证 concat 回来等于原文去掉空白。
 */
export function splitClauses(text: string, maxChars = CLAUSE_MAX_CHARS): string[] {
  const trimmed = text.trim()
  if (trimmed === '') return []
  const raw: string[] = []
  let current = ''
  for (const char of trimmed) {
    current += char
    if (BREAK_CHARS.includes(char)) {
      raw.push(current)
      current = ''
    }
  }
  if (current.trim() !== '') raw.push(current)

  const merged: string[] = []
  for (const piece of raw) {
    const text = piece.trim()
    if (text === '') continue
    const last = merged[merged.length - 1]
    if (last !== undefined && (text.length < CLAUSE_MIN_CHARS || last.length + text.length <= CLAUSE_MIN_CHARS)) {
      merged[merged.length - 1] = last + text
      continue
    }
    merged.push(text)
  }

  const capped: string[] = []
  for (const clause of merged) {
    if (clause.length <= maxChars) {
      capped.push(clause)
      continue
    }
    let rest = clause
    while (rest.length > maxChars) {
      capped.push(rest.slice(0, maxChars))
      rest = rest.slice(maxChars)
    }
    if (rest !== '') capped.push(rest)
  }
  return capped.filter((clause) => clause.trim() !== '')
}

/** 一句话要不要走子句流水的唯一判定点：开关关着就还是一整句。 */
export function clauseStreamPlan(options: {
  text: string
  enabled: boolean
  maxChars?: number
}): { clauses: string[]; streamed: boolean } {
  if (!options.enabled) return { clauses: [options.text.trim()].filter((one) => one !== ''), streamed: false }
  const clauses = splitClauses(options.text, options.maxChars)
  if (clauses.length <= 1) return { clauses, streamed: false }
  return { clauses, streamed: true }
}

/** 一句的结局：翻译回来是空串，或翻译直接抛错，都算 skip。 */
export type ClauseOutcome = 'spoken' | 'skipped' | 'failed'

export interface ClauseStreamResult {
  /** 每句的结局，顺序与 clauses 一致。 */
  outcomes: ClauseOutcome[]
  /** 每句的译文（跳过/失败的句是空串），顺序与 clauses 一致。 */
  texts: string[]
  spoken: number
  skipped: number
  /** 第一句出声的时间点（相对调用的毫秒数）；一句都没出就是 null。 */
  firstSpokenAt: number | null
  /** 最后一句朗读完成的毫秒数（相对调用）。 */
  endedAt: number | null
}

/**
 * 子句流水本体：翻译并行发出，朗读严格按序。
 *
 * 为什么翻译要一次性全发出：慢的是往返，不是顺序；先发出后排队，第二句的往返
 * 就藏进第一句的合成与朗读里。为什么朗读不能并行：声音是单轨的，插队就是串音。
 *
 * 依赖全部注入，探针用假函数就能钉住「顺序、跳过、首句先出」这三件事。
 */
export async function runClauseStream(deps: {
  clauses: string[]
  translate: (clause: string) => Promise<string>
  speak: (text: string) => Promise<void>
  /** 单调递增毫秒，默认 Date.now，探针注入假时钟。 */
  now?: () => number
}): Promise<ClauseStreamResult> {
  const now = deps.now ?? Date.now
  const startedAt = now()
  const clauses = deps.clauses
  // 一次全发：失败在这里不抛，留给按序朗读时结账。
  const translations = clauses.map((clause) =>
    Promise.resolve()
      .then(() => deps.translate(clause))
      .then(
        (text) => ({ ok: true as const, text }),
        () => ({ ok: false as const, text: '' })
      )
  )
  const outcomes: ClauseOutcome[] = []
  const texts: string[] = []
  let firstSpokenAt: number | null = null
  let spoken = 0
  let skipped = 0
  for (let index = 0; index < clauses.length; index += 1) {
    const translated = await translations[index]
    texts.push(translated.ok ? translated.text : '')
    if (!translated.ok || translated.text.trim() === '') {
      outcomes.push('skipped')
      skipped += 1
      continue
    }
    try {
      if (firstSpokenAt === null) firstSpokenAt = now() - startedAt
      await deps.speak(translated.text)
      outcomes.push('spoken')
      spoken += 1
    } catch {
      outcomes.push('failed')
    }
  }
  return { outcomes, texts, spoken, skipped, firstSpokenAt, endedAt: now() - startedAt }
}

/** 一行给人看的账：面板/日志共用，省得两处各写一套措辞。 */
export function clauseStreamLine(result: ClauseStreamResult): string {
  const total = result.outcomes.length
  if (total === 0) return '没有可读的子句'
  const failed = result.outcomes.filter((outcome) => outcome === 'failed').length
  const first = result.firstSpokenAt === null ? '一句都没出' : `首句 ${result.firstSpokenAt}ms`
  const tail = failed > 0 ? ` · 失败 ${failed}` : ''
  return `子句 ${total}：读 ${result.spoken}、跳 ${result.skipped}${tail} · ${first}`
}
