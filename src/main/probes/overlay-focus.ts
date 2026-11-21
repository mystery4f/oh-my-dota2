/**
 * 呼出面板的键盘焦点探针（#103）：只钉纯函数——焦点往哪走、会不会掉出面板。
 *
 * 为什么可纯：`src/shared/panel-focus.ts` 把所有「按了什么键 → 焦点去哪」写成了函数，
 * DOM 那边只负责照着搬。于是「末行 Tab 回 tab1」「首行 Shift+Tab 回关闭」「焦点永不出两个环」
 * 这三句都能在没有窗口的情况下验。
 */
import { PANEL_PAGE_ROWS, rowNextIndex, tabHandoff, tabNextIndex } from '@shared/panel-focus'
import { finishProbe, probeCases } from './harness'

/** tab 环的长度：四个 tab + 关闭。 */
const TABS = 5

export async function runOverlayFocusProbe(): Promise<void> {
  const { cases, push: check } = probeCases()

  // —— 两个换手点：这两句是票面验收，别的都可以商量，这两句不能变
  const fromClose = tabHandoff({ zone: 'tabs', index: TABS - 1, tabs: TABS, shift: false })
  check('末位「关闭」按 Tab 进入行环首项', fromClose.zone === 'rows' && fromClose.index === 0, JSON.stringify(fromClose))
  const lastRow = tabHandoff({ zone: 'rows', index: 19, tabs: TABS, shift: false })
  check('末行按 Tab 回第一个 tab', lastRow.zone === 'tabs' && lastRow.index === 0, JSON.stringify(lastRow))
  const firstRowBack = tabHandoff({ zone: 'rows', index: 0, tabs: TABS, shift: true })
  check('首行按 Shift+Tab 回「关闭」', firstRowBack.zone === 'tabs' && firstRowBack.index === TABS - 1, JSON.stringify(firstRowBack))

  // —— 组内移动：tab 环循环、行环不循环（行环两端就是换手点）
  check('tab 环内 Tab 往后走一个', tabHandoff({ zone: 'tabs', index: 1, tabs: TABS, shift: false }).index === 2)
  check('tab 环内 Shift+Tab 从第一个绕到「关闭」', tabHandoff({ zone: 'tabs', index: 0, tabs: TABS, shift: true }).index === TABS - 1)
  // 行与行之间走方向键：行环里 Tab 一律换组，两百行才不会被 Tab 一格一格拖过去。
  check('行环里按 Tab 一律回第一个 tab', tabHandoff({ zone: 'rows', index: 3, tabs: TABS, shift: false }).index === 0)
  check('行环里 Shift+Tab 一律回「关闭」', tabHandoff({ zone: 'rows', index: 3, tabs: TABS, shift: true }).index === TABS - 1)
  check('左右键在四个 tab 之间循环，不碰关闭', tabNextIndex(3, TABS, 'ArrowRight') === 0 && tabNextIndex(0, TABS, 'ArrowLeft') === 3)
  check('左右键不认别的键', tabNextIndex(1, TABS, 'ArrowUp') === null)

  // —— 行内移动：上下、翻页、首末
  check('下键下一行、上键上一行', rowNextIndex(2, 10, 'ArrowDown') === 3 && rowNextIndex(2, 10, 'ArrowUp') === 1)
  check('首行上键停在首行、末行下键停在末行', rowNextIndex(0, 10, 'ArrowUp') === 0 && rowNextIndex(9, 10, 'ArrowDown') === 9)
  check(
    `PageDown/PageUp 一次 ${PANEL_PAGE_ROWS} 行`,
    rowNextIndex(0, 200, 'PageDown') === PANEL_PAGE_ROWS && rowNextIndex(60, 200, 'PageUp') === 60 - PANEL_PAGE_ROWS
  )
  check('翻页在两端夹住', rowNextIndex(195, 200, 'PageDown') === 199 && rowNextIndex(3, 200, 'PageUp') === 0)
  check('Home/End 到首末行', rowNextIndex(77, 200, 'Home') === 0 && rowNextIndex(3, 200, 'End') === 199)
  check('不是行键就不吞', rowNextIndex(3, 200, 'Enter') === null && rowNextIndex(3, 200, 'a') === null)
  check('一行都没有时不给下标', rowNextIndex(0, 0, 'ArrowDown') === null)

  // —— 焦点不出浮层：把每个位置、四个行数、两个方向都走一遍
  let outside = 0
  for (const rows of [1, 2, 20, 200]) {
    for (const shift of [false, true]) {
      for (let i = 0; i < TABS; i += 1) {
        const slot = tabHandoff({ zone: 'tabs', index: i, tabs: TABS, shift })
        const count = slot.zone === 'tabs' ? TABS : rows
        if (slot.index < 0 || slot.index >= count) outside += 1
      }
      for (let i = 0; i < rows; i += 1) {
        const slot = tabHandoff({ zone: 'rows', index: i, tabs: TABS, shift })
        const count = slot.zone === 'tabs' ? TABS : rows
        if (slot.index < 0 || slot.index >= count) outside += 1
      }
    }
  }
  check('任何位置按 Tab/Shift+Tab 都落在两个环里', outside === 0, `越界 ${outside} 次`)

  finishProbe('OVERLAY_FOCUS_PROBE', cases)
}
