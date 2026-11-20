/**
 * 战况摘要（#99）：抬头那一行只说**已经有的行**里的话。
 *
 * 设计底线是票面那句「摘要绝不编造消息里没有的内容」，所以这里不做任何改写：
 * 摘要是**挑选 + 拼接**——从最近几行里按「战场意图」的固定词表挑最多三句，
 * 原样搬过来，用 ` · ` 串起来；被省掉的行程用 `+N` 标出来，点开还是原来那些行。
 *
 * 也因此它一次模型调用都不发：没有新内容可编，就不需要模型；
 * 「是不是要一行摘要」由设置决定（settings.overlayDigest），关掉就回到逐行列表。
 */
import type { LedgerRow } from './overlay-ledger'

/** 摘要里最多搬几行：再多就不是「一眼」了。 */
export const DIGEST_ROWS = 3

/** 每句搬过来截多长：摘要是一瞥，不是第二条聊天列表。 */
export const DIGEST_CLIP = 42

/**
 * 战场意图词表：命中越多越靠前。全部是**判断要不要搬**的依据，
 * 命中之后搬的还是原句本身——词表不参与造句。
 */
const CUES: readonly RegExp[] = [
  /不见了|miss|missing|消失/i,
  /小心|注意|care|watch|incoming/i,
  /需要|need|要个|要一个/i,
  /推|push|推进|上高|高地/i,
  /撤|back|退|回防/i,
  /买|buy|买活|buyback/i,
  /眼|ward|插眼|反眼/i,
  /肉山|rosh|roshan/i,
  /符|rune/i,
  /tp|传送/i
]

/** 一行要展示的文字：有译文就用译文，否则原文（自己说的话永远原文）。 */
export function digestRowText(row: LedgerRow): string {
  const text = (row.translated ?? row.original ?? '').trim()
  return text.replace(/\s+/g, ' ')
}

/** 一句话命中了几条意图词。 */
export function digestCues(text: string): number {
  return CUES.reduce((hit, pattern) => (pattern.test(text) ? hit + 1 : hit), 0)
}

/** 截断，超长补省略号（摘要里不出现没头没尾的半句）。 */
function clip(text: string): string {
  return text.length <= DIGEST_CLIP ? text : `${text.slice(0, DIGEST_CLIP - 1)}…`
}

/**
 * 抬头那一行。空列表给空串——浮层据此整行不画，而不是显示一个「暂无」的空壳。
 *
 * 顺序就是重要性：意图词命中多的在前，命中一样多时后说的在前（最多三句）。
 * 排完不再按时间重排——一眼看过去第一句必须是最要紧的那句，否则这一行就白给了。
 * 排序不含随机量，同一批消息每次得到同一行摘要。
 */
export function digestLine(rows: readonly LedgerRow[], limit = DIGEST_ROWS): string {
  const scored = rows
    .map((row, index) => ({ index, text: digestRowText(row), cues: digestCues(digestRowText(row)) }))
    .filter((item) => item.text.length > 0)
  if (scored.length === 0) return ''
  const picked = [...scored]
    .sort((a, b) => (b.cues === a.cues ? b.index - a.index : b.cues - a.cues))
    .slice(0, limit)
  const head = picked.map((item) => clip(item.text)).join(' · ')
  const rest = scored.length - picked.length
  return rest > 0 ? `${head} +${rest}` : head
}
