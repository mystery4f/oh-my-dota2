import { BrowserWindow, screen } from 'electron'
import { join } from 'node:path'
import { loadSettings, saveSettings } from '../services/settings'
import { BOARD_HEIGHT, BOARD_WIDTH } from '@shared/board-view'
import { fitInside, planBounds } from '@shared/display-geometry'
import type { OverlayGeometry } from '@shared/ipc'

/**
 * 副屏看板（#124a）：一块 320 宽的无边框置顶窗，只读 `matchSnapshot()`。
 *
 * 两条不能破的规矩：
 * - **不动浮层**：这里不引用 `getOverlayManager()`，也不调 `show()`/`setVisible()`；
 *   「关掉看板 = 游戏一动不动」靠的是根本没有那条调用路径，不是靠条件判断。
 * - **位置单独记**：`settings.boardBounds`，与 `overlayBoundsByDisplay` 是两个键。
 */

const REMEMBER_DEBOUNCE_MS = 600

class BoardWindowManager {
  private win: BrowserWindow | null = null
  private timer: NodeJS.Timeout | null = null

  /** 设置里 `boardVisible` 为真时开会、为假时关掉；幂等。 */
  sync(visible: boolean): void {
    if (visible) this.show()
    else this.hide()
  }

  get opened(): boolean {
    return this.win !== null && !this.win.isDestroyed()
  }

  /** 记下来的位置还落在某块屏幕上就用它，否则落到主屏右上角（不盖住浮层常用位置）。 */
  private startBounds(): OverlayGeometry {
    const displays = screen.getAllDisplays().map((d) => ({
      id: String(d.id),
      workArea: d.workArea,
      primary: d.id === screen.getPrimaryDisplay().id
    }))
    const saved = loadSettings().boardBounds
    if (saved !== null) {
      // 记下来的位置当作「上次停在哪儿」，交给同一套夹取逻辑算落点（屏幕拔了会整块回主屏）。
      const plan = planBounds({ previous: saved }, displays, { key: 'previous' })
      if (plan !== null && plan.geometry !== null) return plan.geometry
    }
    const primary = screen.getPrimaryDisplay().workArea
    return fitInside(
      { x: primary.x + primary.width - BOARD_WIDTH - 24, y: primary.y + 24, width: BOARD_WIDTH, height: BOARD_HEIGHT },
      primary
    )
  }

  show(): BrowserWindow {
    if (this.opened && this.win) return this.win
    const geometry = this.startBounds()
    const win = new BrowserWindow({
      ...geometry,
      frame: false,
      resizable: false,
      show: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      fullscreenable: false,
      maximizable: false,
      minimizable: false,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        // 看板靠秒级轮询刷新；节流会让它看起来「卡住了」。
        backgroundThrottling: false
      }
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    this.win = win
    win.on('moved', () => this.remember())
    win.on('closed', () => {
      if (this.win === win) this.win = null
      if (this.timer) {
        clearTimeout(this.timer)
        this.timer = null
      }
    })
    const target = win
    win.webContents.once('did-finish-load', () => {
      if (!target.isDestroyed()) target.showInactive()
    })
    if (process.env.ELECTRON_RENDERER_URL) {
      void target.loadURL(process.env.ELECTRON_RENDERER_URL + '/board.html')
    } else {
      void target.loadFile(join(__dirname, '../renderer/board.html'))
    }
    return win
  }

  hide(): void {
    if (!this.opened || !this.win) return
    const win = this.win
    this.win = null
    win.destroy()
  }

  /** 拖动结束 600 ms 后落一次盘：每挪一像素写一次设置会把 settings.json 磨烂。 */
  private remember(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => {
      this.timer = null
      const win = this.win
      if (!win || win.isDestroyed()) return
      const box = win.getBounds()
      try {
        saveSettings({ boardBounds: { x: box.x, y: box.y, width: box.width, height: box.height } })
      } catch {
        // 记不住位置不该让窗口报错：下一次开在主屏默认角落就够用了。
      }
    }, REMEMBER_DEBOUNCE_MS)
  }

  dispose(): void {
    this.hide()
  }
}

let manager: BoardWindowManager | null = null

export function getBoardWindow(): BoardWindowManager {
  if (!manager) manager = new BoardWindowManager()
  return manager
}
