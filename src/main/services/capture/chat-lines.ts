
/**
 * 聊天行解析与续行合并。
 *
 * Dota 2 每条玩家消息都以 `昵称: 内容` 或 `[All] 昵称: 内容` 开头；被自动换行切开的续行没有这个前缀，
 * 且左缩进与首行一致。实测（PaddleOCR，760×220 合成图）：行高 23–26px、相邻行空隙 3–5px，
 * 真实相邻两条消息的空隙同样只有 3–5px，所以「只看间距」无法区分续行与新消息，必须叠加前缀判据。
 */

export interface ParsedChatLine {
  /** `[All]` / `[Team]` 等频道标记，原样保留；无则空串。 */
  channel: string
  /** 玩家昵称；无则空串（系统消息、续行残留）。 */
  speaker: string
  /** 真正要翻译的正文。 */
  body: string
}

/** 频道标记：[All] / [Team] / [队友] / [观战] 之类，最长 12 字符。 */
const CHANNEL_RE = /^\s*(\[[^\]\n]{1,12}\])\s*/
/**
 * 昵称前缀：`昵称:` / `[队友] 昵称:` / `昵称 :`（真实 Dota 行在冒号前留空格）都算一条新消息。
 * 上限给到 48 字符：`[队友] Balance(Bot) [LISA.]` 这类带频道、带 (Bot) 后缀、带方括号的长名实测 26 字符，
 * 24 字符会把它判成「续行」，于是整屏消息被并成一条（实测 bug）。冒号后必须还有内容，避免把「wtf:」这类正文尾巴当前缀。
 */
const SPEAKER_RE = /^([^:：\n]{1,48}?)\s*[:：]\s*(?=\S)/
/**
 * 一行 OCR 文本是不是「一条新消息」的开头：有昵称前缀就算。
 * 合并与拆分共用同一条判据，避免两处规则漂移。
 */
export function startsNewMessage(text: string): boolean {
  return SPEAKER_RE.test(text.trim())
}

/** 一条消息内部的第二个 `[频道]` + 冒号标记：OCR 把相邻两行并成一行时，用它切开。 */
const INLINE_START_RE = /(?:\[|【)[^\]】\n]{1,14}(?:\]|】|」|』)?\s*[^:：\n]{1,40}?\s*[:：]\s*(?=\S)/g

/**
 * 把被 OCR 并成一行的多条消息拆开。只在「方括号开头 + 后面很快出现冒号」处切，
 * 正文里的普通冒号（如 `wtf: no`）不会被误切。
 */
export function splitInlineMessages(text: string): string[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []
  const cuts: number[] = []
  for (const match of trimmed.matchAll(INLINE_START_RE))
    if (match.index !== undefined && match.index > 0) cuts.push(match.index)
  if (cuts.length === 0) return [trimmed]
  const parts: string[] = []
  let start = 0
  for (const cut of cuts) {
    const piece = trimmed.slice(start, cut).trim()
    if (piece.length > 0) parts.push(piece)
    start = cut
  }
  const tail = trimmed.slice(start).trim()
  if (tail.length > 0) parts.push(tail)
  return parts
}


/** 汉字占比 ≥0.3 视为中文行：Dota 聊天里中英混排是「两条不同消息」的典型信号。 */
export function isHanText(text: string): boolean {
  const letters = text.replace(/[^\p{L}\p{N}]/gu, '')
  if (letters.length === 0) return false
  const han = letters.match(/[\u3400-\u9fff]/g)?.length ?? 0
  return han / letters.length >= 0.3
}
/**
 * 把 OCR 行按「续行」规则合并成完整消息。
 * 判据（全部满足才合并）：空隙 ≤ 0.5 行高、左缩进差 ≤ 24px、下一行没有昵称前缀、
 * 上一行不以句末标点结束、合并后不超过 180 字符。
 */
/** 去空白、去标点、去符号后的小写串，用作精确判重键（OCR 的标点/大小写噪声不该算新消息）。 */
export function normalizeLine(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase()
}

/** 近似判重的两侧最短长度与长度差容忍度：滚动时被裁剩的同一条消息两侧会差几个字符。 */
const NEAR_DUP_MIN_CHARS = 8
const NEAR_DUP_LENGTH_RATIO = 0.25
/** 近似判重要求的字符差异上限：至少 2 个字符，且不超过较长者的 10%。 */
const NEAR_DUP_MIN_EDITS = 2
const NEAR_DUP_EDIT_RATIO = 0.1

/** 一条消息是另一条的前缀或后缀（长度相近）即算重复：聊天滚动会把同一条消息裁成两截重复出现。 */
/** 编辑距离（只用于 ≤180 字符的聊天行，O(n*m) 足够）。 */
function editDistance(a: string, b: string): number {
  const prev: number[] = new Array(b.length + 1)
  const cur: number[] = new Array(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    cur[0] = i
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost)
    }
    for (let j = 0; j <= b.length; j++) prev[j] = cur[j]
  }
  return prev[b.length]
}

export function isNearDuplicate(text: string, recent: string[]): boolean {
  // 两侧都归一化（去空白/标点/大小写）：OCR 的标点噪声不该把同一条消息判成新消息。
  const probe = normalizeLine(text)
  if (probe.length < NEAR_DUP_MIN_CHARS) return false
  for (const raw of recent) {
    const other = normalizeLine(raw)
    if (other.length < NEAR_DUP_MIN_CHARS) continue
    const shorter = probe.length <= other.length ? probe : other
    const longer = shorter === probe ? other : probe
    if (longer.length - shorter.length > longer.length * NEAR_DUP_LENGTH_RATIO) continue
    if (!longer.startsWith(shorter) && !longer.endsWith(shorter)) continue
    // 只是前缀相同不等于同一条消息（'push top now A1' 与 'push top now B2'），要差得足够少。
    const allowed = Math.max(NEAR_DUP_MIN_EDITS, Math.round(longer.length * NEAR_DUP_EDIT_RATIO))
    if (editDistance(shorter, longer) <= allowed) return true
  }
  return false
}
/**
 * 拆出频道、昵称与正文。频道与昵称由调用方原样回填，模型只接触正文，
 * 因此翻译物理上无法弄丢玩家名。
 */
export function parseChatLine(text: string): ParsedChatLine {
  let rest = text.trim()
  let channel = ''
  const channelMatch = rest.match(CHANNEL_RE)
  if (channelMatch !== null) {
    channel = channelMatch[1]
    rest = rest.slice(channelMatch[0].length)
  }
  const speakerMatch = rest.match(SPEAKER_RE)
  if (speakerMatch !== null) {
    const speaker = speakerMatch[1].trim()
    const body = rest.slice(speakerMatch[0].length).trim()
    if (speaker.length > 0 && body.length > 0) return { channel, speaker, body }
  }
  return { channel, speaker: '', body: rest }
}

/** 回填前缀，与输入格式保持一致（`[All] 昵称: 正文`）。 */
export function formatChatPrefix(parsed: ParsedChatLine): string {
  const head = [parsed.channel, parsed.speaker === '' ? '' : `${parsed.speaker}:`]
    .filter((part) => part !== '')
    .join(' ')
  return head === '' ? '' : `${head} `
}
