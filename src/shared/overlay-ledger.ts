/**
 * 浮层行账本的纯缝（beside overlay-state）：上限裁剪、渐隐档位、未读计数、英雄色相、
 * 快捷短语环绕，全部是无副作用的决策；渲染层只执行，探针直接喂对象断言。
 */
import type { CaptureEntry } from './ipc'

/** 行数上限：超出裁最旧——浮层是字幕不是聊天记录，呼出面板才看长历史。 */
/** 行数上限：超出裁最旧——浮层是字幕不是聊天记录，呼出面板才看长历史。 */
export const LEDGER_MAX_ROWS = 40
/** 呼出面板的历史上限：比分区页更长，也远小于区文件的硬上限。 */
export const HISTORY_MAX_ROWS = 200
/** 多久没更新就降到暗档：保留上下文但不抢视线。 */
export const FADE_AFTER_MS = 12_000

/** 行 = 账本条 + 渐隐档位；数组语义（追加/更新/裁剪）都在这里，渲染层不自己 sort。 */
export type LedgerRow = CaptureEntry & { dim: boolean }

/**
 * 追加或就地更新一行。同 id（译文补齐、失败改写）保持原位且继承渐隐档位；
 * 新行追加到尾部，超上限裁最旧。返回新数组，不改入参。
 */
export function pushEntry(rows: LedgerRow[], entry: CaptureEntry): LedgerRow[] {
  const index = rows.findIndex((row) => row.id === entry.id)
  if (index >= 0) {
    const next = rows.slice()
    next[index] = { ...entry, dim: rows[index].dim }
    return next
  }
  const appended = [...rows, { ...entry, dim: false }]
  return appended.length > LEDGER_MAX_ROWS ? appended.slice(appended.length - LEDGER_MAX_ROWS) : appended
}

/** 一次推进所有行的渐隐档位：渲染层每秒一拍即可，不必每行一个计时器。 */
export function fadeRows(rows: LedgerRow[], now: number): LedgerRow[] {
  return rows.map((row) => ({ ...row, dim: now - row.ts >= FADE_AFTER_MS }))
}

/** 未读计数：收起时来新行 +1，展开或未收起恒 0。 */
export function nextUnread(count: number, collapsed: boolean, incoming: boolean): number {
  if (!collapsed) return 0
  return incoming ? count + 1 : count
}

/**
 * 英雄名 → 色相（行左缘 3px 色条）：FNV-1a 散列，同一英雄恒同色。
 * 40–70 的琥珀区间整体跳过（和警告色撞脸）；签名行没有英雄，返回 null = 不画色条。
 */
export function heroHue(name: string | undefined): number | null {
  if (!name) return null
  let hash = 0x811c9dc5
  for (let i = 0; i < name.length; i++) {
    hash ^= name.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  const raw = (hash >>> 0) % 330
  return raw >= 40 ? raw + 30 : raw
}

/** 快捷短语选择：方向键环绕（-1 再按下走到 0，0 再往上走到末尾），空表恒 -1。 */
export function pickPhrase(length: number, index: number): number {
  if (length <= 0) return -1
  return ((index % length) + length) % length
}
