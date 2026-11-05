/**
 * 原地直发（shift+alt+t）的纯决策缝：读到的这句该不该翻、译文回来还能不能写回、失败的时候浮层该说哪句话。
 * 主进程、探针、渲染端共用，不含 Electron 依赖。
 *
 * 这条流水线有一个别的链路没有的坑：`grab` 一读完就把游戏聊天框清空了，那句中文只活在内存里。
 * 所以每一处放弃都不能只是 throw —— 先决定「原文还回不回去」，再决定报什么。
 */

/**
 * 读走之后超过这个时间才回来的译文不再写回。
 * 一次直发最坏能到几十秒（排队 + 对冲 + 重译），而人早就开始打下一句了；
 * 这时候写回去不是翻译旧消息那么简单，是把旧消息粘出来回车发出去。
 */
export const INPLACE_STALE_MS = 20_000

/** 失败落在哪一步：读聊天框、翻译、还是写回。热键路径只靠这句话告诉用户「按了为什么没反应」。 */
export type InPlaceStage = 'grab' | 'translate' | 'send'

/** 一次 grab 的结果摊平成纯输入；`code` 是桥错误码，只有 NOCONTENT 才允许接手上一句。 */
export interface InPlaceGrabInput {
  ok: boolean
  text?: string | null
  /** bridge 给的错误码（NOCONTENT / NOGAME / NOFOCUS / EMPTY / BADOP…）。 */
  code?: string | null
  /** 桥给的人话错误。 */
  error?: string | null
  /** 上一次被打断、但还没写回的原文：聊天框已经空了，它就是那一句。 */
  orphan?: string | null
}

export type InPlaceDraft =
  | { kind: 'fresh'; draft: string }
  | { kind: 'orphan'; draft: string }
  | { kind: 'empty' }
  | { kind: 'fail'; reason: string }

/** 聊天框空着的错误码：只有这一种失败可以接手上一句原文，NOGAME/NOFOCUS 时聊天框里可能还有字。 */
const NO_CONTENT_CODE = 'NOCONTENT'

/**
 * 这次该翻哪一句。
 *
 * 第二次按热键时第一句的中文已经被读走、聊天框清空了，于是新的 grab 拿到 NOCONTENT ——
 * 这恰恰是「打断上一次继续翻那一句」的正常形态，不能报成「没有读到内容」让用户白按一次。
 */
export function pickInPlaceDraft(input: InPlaceGrabInput): InPlaceDraft {
  const text = (input.text ?? '').trim()
  if (input.ok && text !== '') return { kind: 'fresh', draft: text }
  const orphan = (input.orphan ?? '').trim()
  const emptyCode = !input.ok && input.code === NO_CONTENT_CODE
  if ((!input.ok ? emptyCode : text === '') && orphan !== '') return { kind: 'orphan', draft: orphan }
  if (input.ok) return { kind: 'empty' }
  return { kind: 'fail', reason: (input.error ?? '').trim() || '没有读到聊天框内容' }
}

/** 译文回来了，这一刻还能不能写回聊天框。 */
export interface InPlaceArrival {
  /** 已经被新的直发取代（用户又按了一次）：一律不碰聊天框，箱子归新的那一次。 */
  cancelled: boolean
  /** 归一化之后的英文行；null = 没翻成。 */
  line: string | null
  /** 从 grab 成功到现在的毫秒数。 */
  elapsedMs: number
}

export type InPlaceDelivery =
  | { action: 'send'; line: string }
  | { action: 'restore'; reason: string }
  | { action: 'abandon'; reason: string }

/**
 * 三选一：写回去 / 把原文放回聊天框 / 什么都不做。
 * 只有「还没被打断 + 有英文 + 没迟到」才允许写回，其余都把原文还原成用户打的样子（不按回车）。
 */
export function decideInPlaceDelivery(input: InPlaceArrival): InPlaceDelivery {
  if (input.cancelled) return { action: 'abandon', reason: '已被新的直发打断' }
  const line = (input.line ?? '').trim()
  if (line === '') return { action: 'restore', reason: '没有翻出可以发送的英文' }
  if (input.elapsedMs >= INPLACE_STALE_MS) {
    const seconds = Math.round(input.elapsedMs / 1000)
    return { action: 'restore', reason: `译文回来晚了（${seconds} 秒）` }
  }
  return { action: 'send', line }
}

/**
 * 浮层那一行提示。热键路径没有 UI 接返回值，失败了必须有人说话，
 * 而且必须说清「原文回没回去」——用户最怕的是那句中文没了。
 */
/** 理由最长留这么多字：翻译器抓回来的错误可能是整段接口报文，浮层那一行放不下。 */
const MAX_REASON = 60

export function inplaceFailureLine(input: { reason: string; restored: boolean }): string {
  const raw = input.reason.trim() || '没翻成'
  const head = raw.length > MAX_REASON ? `${raw.slice(0, MAX_REASON)}…` : raw
  return input.restored ? `直发失败：${head}（原文已放回聊天框）` : `直发失败：${head}`
}
