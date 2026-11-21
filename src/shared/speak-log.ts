/**
 * #164：朗读腿的静默路径要能被数出来。
 *
 * 五种跳过理由（`mute` / `own` / `muted-player` / `pending` / `empty`）与「被更新的
 * 一拍顶掉」那条丢弃，过去只 `console.log`。打包版没人看控制台，验收就只能靠耳朵，
 * 而耳朵只会给一个结论：他没被念。日志才能回答「是被人静音了，还是总开关关了」。
 *
 * 这里只放形状与判据，不碰文件：调用点拿到对象后交给同一个上限写入器
 * `logs/voice-chain.jsonl`（不要为它新开文件——收工后要一条时间线看完一局）。
 */

/** 五条静默路径，与 `speakSkipReason()` 的返回值逐字一致。 */
export type SpeakSkipReason = 'mute' | 'own' | 'muted-player' | 'pending' | 'empty'

/**
 * 值得落盘的跳过理由：五种全落。
 *
 * 只记 `muted-player` 会漏掉「我只是被总开关关了」这类最容易被误判成 bug 的情形；
 * 而 `pending` / `empty` 是翻译链路的健康度，少了它们「这句怎么没念」仍然无解。
 */
export const SPEAK_LOGGED_REASONS: readonly SpeakSkipReason[] = ['mute', 'own', 'muted-player', 'pending', 'empty']

/** 与控制台那两行保持一致的截断长度：够认出是哪一句，不把整段对局聊天抄进日志。 */
export const SPEAK_LOG_TEXT_MAX = 30

/**
 * 写这一行的腿。**只有朗读腿（`announceEntries()`）会写 `speak-skip`** —— 回复腿与同传腿
 * 给了就念、从不跳过，所以这里没有它们，也没有 `read`：留一个没有写者的枚举值，下一个人
 * 就会以为朗读腿与公告腿是两条。将来真有第二条写者，再加它的名字（#163 同一条理由）。
 */
export type SpeakLogStage = 'announce' | 'unknown'

export interface SpeakSkipLine {
  at: string
  kind: 'speak-skip'
  stage: SpeakLogStage
  reason: SpeakSkipReason
  own: boolean
  text: string
}

export interface SpeakDropLine {
  at: string
  kind: 'speak-drop'
  stage: SpeakLogStage
  text: string
}

export interface SpeakSkipInput {
  reason: SpeakSkipReason | null
  own: boolean
  text: string
  at?: string | number | Date
  stage?: SpeakLogStage
}

export interface SpeakDropInput {
  text: string
  at?: string | number | Date
  stage?: SpeakLogStage
}

/** 统一时刻：ISO 字符串，写不出合法值就退回现在（日志里不许出现 `Invalid Date`）。 */
export function speakLogAt(at: string | number | Date | undefined): string {
  if (typeof at === 'string' && at !== '') return at
  const stamp = at instanceof Date ? at.getTime() : typeof at === 'number' ? at : Date.now()
  const date = new Date(Number.isFinite(stamp) ? stamp : Date.now())
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString()
}

/** 日志里的正文：单行、截断，绝不夹带玩家 id 或别的字段。 */
export function speakLogText(text: string): string {
  return String(text ?? '')
    .replace(/[\r\n]+/g, ' ')
    .slice(0, SPEAK_LOG_TEXT_MAX)
}

/** 这条跳过值不值得落盘（纯判据：调用点不许自己 if 一串 reason）。 */
export function shouldLogSkip(reason: SpeakSkipReason | null): reason is SpeakSkipReason {
  return reason !== null && SPEAK_LOGGED_REASONS.includes(reason)
}

/**
 * 一行跳过。`reason` 为 null（其实没跳过）返回 null——宁可不写，也不写一条自相矛盾的行。
 *
 * `own` 必写：`reason: 'own'` 与「自己那句」是两件事，混起来就看不出是哪条规则拦的。
 */
export function speakSkipLine(input: SpeakSkipInput): SpeakSkipLine | null {
  if (!shouldLogSkip(input.reason)) return null
  return {
    at: speakLogAt(input.at),
    kind: 'speak-skip',
    stage: input.stage ?? 'announce',
    reason: input.reason,
    own: input.own === true,
    text: speakLogText(input.text)
  }
}

/** 一行丢弃（宣布时已被更新的一拍顶掉）。 */
export function speakDropLine(input: SpeakDropInput): SpeakDropLine {
  return {
    at: speakLogAt(input.at),
    kind: 'speak-drop',
    stage: input.stage ?? 'announce',
    text: speakLogText(input.text)
  }
}

/** 面板/验收读的一句：`跳过 3 次（按人静音 2 · 总开关 1）` 这种形状由调用方拼，这里只给口径。 */
export function speakReasonLabel(reason: SpeakSkipReason): string {
  switch (reason) {
    case 'mute':
      return '总开关关着'
    case 'own':
      return '自己说的话'
    case 'muted-player':
      return '按人静音'
    case 'pending':
      return '还在翻译'
    case 'empty':
      return '没有正文'
  }
}
