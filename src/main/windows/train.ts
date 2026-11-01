import { BrowserWindow } from 'electron'
import { join } from 'node:path'

/**
 * 训练管理窗口：看进度、看日志、能停。训练跑多久都可能，独立窗口比面板里塞一块省心，
 * 也和「面板可以对局关掉」互不牵连。
 */
class TrainWindowManager {
  private win: BrowserWindow | null = null

  open(): void {
    if (this.win && !this.win.isDestroyed()) {
      if (this.win.isMinimized()) this.win.restore()
      this.win.focus()
      return
    }
    this.win = new BrowserWindow({
      show: false,
      width: 780,
      height: 560,
      title: '训练管理',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true
      }
    })
    this.win.on('closed', () => {
      this.win = null
    })
    this.win.once('ready-to-show', () => this.win?.show())
    if (process.env.ELECTRON_RENDERER_URL) {
      void this.win.loadURL(process.env.ELECTRON_RENDERER_URL + '/train.html')
    } else {
      void this.win.loadFile(join(__dirname, '../renderer/train.html'))
    }
  }
}

let manager: TrainWindowManager | null = null

export function getTrainWindow(): TrainWindowManager {
  if (!manager) manager = new TrainWindowManager()
  return manager
}
