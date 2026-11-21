/**
 * 呼出面板的键盘焦点（#103）。全部是纯函数，DOM 那边只负责「按下 → 问这里 → 搬焦点」。
 *
 * 两条铁律：
 * - 焦点只在两个环里走：tab 环（四个 tab + 关闭）、行环（当前页的行）。永远没有第三个去处。
 * - 行环里 Tab 是「换组」，方向键才是「换行」；两百行不会污染 Tab 的顺序。
 */

/** PageUp / PageDown 一次翻几行：两百行靠方向键一行行走没人受得了。 */
export const PANEL_PAGE_ROWS = 10

export type PanelZone = 'tabs' | 'rows'

export interface TabHandoffInput {
  zone: PanelZone
  /** 组内当前下标。 */
  index: number
  /** tab 环的长度（四个 tab + 关闭）。 */
  tabs: number
  shift: boolean
}

export interface FocusSlot {
  zone: PanelZone
  index: number
}

const wrap = (value: number, count: number): number => ((value % count) + count) % count

/**
 * Tab / Shift+Tab 的去处。tab 环内部循环，走到「关闭」之后 Tab 进行环首行；
 * 行环首行 Shift+Tab 回「关闭」，末行 Tab 回第一个 tab——这就是两组之间的两个换手点。
 */
export function tabHandoff(input: TabHandoffInput): FocusSlot {
  const tabs = Math.max(1, input.tabs)
  if (input.zone === 'tabs') {
    if (input.shift) return { zone: 'tabs', index: wrap(input.index - 1, tabs) }
    if (input.index >= tabs - 1) return { zone: 'rows', index: 0 }
    return { zone: 'tabs', index: input.index + 1 }
  }
  // 行环里 Tab 就是「换组」：行与行之间走方向键，否则两百行会被 Tab 一格一格拖过去。
  if (input.shift) return { zone: 'tabs', index: tabs - 1 }
  return { zone: 'tabs', index: 0 }
}

/** 行环里的移动键；不是行键就返回 null（调用方据此放行，不吞别的键）。 */
export function rowNextIndex(index: number, count: number, key: string): number | null {
  if (count <= 0) return null
  const last = count - 1
  const clamp = (value: number): number => Math.min(last, Math.max(0, value))
  switch (key) {
    case 'ArrowDown':
      return clamp(index + 1)
    case 'ArrowUp':
      return clamp(index - 1)
    case 'PageDown':
      return clamp(index + PANEL_PAGE_ROWS)
    case 'PageUp':
      return clamp(index - PANEL_PAGE_ROWS)
    case 'Home':
      return 0
    case 'End':
      return last
    default:
      return null
  }
}

/** tab 环里的左右移动（四个 tab 之间可以循环；关闭按钮不参与左右键）。 */
export function tabNextIndex(index: number, tabs: number, key: string): number | null {
  const ring = Math.max(1, tabs - 1)
  if (key === 'ArrowRight') return wrap(index + 1, ring)
  if (key === 'ArrowLeft') return wrap(index - 1, ring)
  return null
}
