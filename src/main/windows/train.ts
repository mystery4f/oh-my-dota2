import { app, BrowserWindow } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

// 渲染进程 console 落盘，录制链路排障用（logs/train-window.log）
function appendTrainRendererLog(line: string): void {
  try {
    const dir = join(app.getAppPath(), 'logs')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'train-window.log'), `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {
    // 日志失败不影响窗口
  }
}
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
    this.win.webContents.on('console-message', (payload) => {
      const text = typeof payload === 'object' && payload !== null && 'message' in payload
        ? String(payload.message)
        : ''
      if (text) appendTrainRendererLog(text)
      else appendTrainRendererLog('(console-message: no message field, legacy form?)')
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
