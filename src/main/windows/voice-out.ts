import { BrowserWindow, ipcMain } from 'electron'
import { join } from 'node:path'
import {
  IPC,
  type VoiceOutEndedReport,
  type VoiceOutPlayRequest,
  type VoiceOutReadyReport
} from '@shared/ipc'

/**
 * 声出的常驻隐藏窗口：全应用只有它真的在出声。
 * 单独开窗口而不是借用面板/浮层：测试声出要在后台播几秒，浮层会跟着对局走，
 * 面板可能没开；一个独立的小页面让「选设备、解码、播放」有自己的生命周期。
 */
class VoiceOutWindowManager {
  private win: BrowserWindow | null = null
  private readyListeners = new Set<(report: VoiceOutReadyReport) => void>()
  private endedListeners = new Set<(report: VoiceOutEndedReport) => void>()
  private wired = false

  /** 页面脚本就绪（能收 PLAY 了）。每次窗口重建后重新等。 */
  private pageReady: Promise<void> = Promise.resolve()
  private resolvePageReady: (() => void) | null = null

  private wire(): void {
    if (this.wired) return
    this.wired = true
    ipcMain.on(IPC.VOICE_OUT_READY, (_event, report: VoiceOutReadyReport) => {
      for (const listener of this.readyListeners) listener(report)
    })
    ipcMain.on(IPC.VOICE_OUT_ENDED, (_event, report: VoiceOutEndedReport) => {
      for (const listener of this.endedListeners) listener(report)
    })
  }

  /** 确保窗口开着且页面加载完（冷启动首次要等 renderer 就绪，别把 PLAY 发进虚空）。 */
  async ensure(): Promise<BrowserWindow> {
    this.wire()
    if (this.win && !this.win.isDestroyed()) return this.win
    this.win = new BrowserWindow({
      show: false,
      skipTaskbar: true,
      width: 1,
      height: 1,
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true,
        // 隐藏窗口的计时器/音频不能被节流：ENDED 迟到会拖长说话键的按住时间。
        backgroundThrottling: false
      }
    })
    this.win.on('closed', () => {
      this.win = null
    })
    this.pageReady = new Promise<void>((resolve) => {
      this.resolvePageReady = resolve
    })
    const target = this.win
    target.webContents.once('did-finish-load', () => {
      if (this.resolvePageReady) {
        this.resolvePageReady()
        this.resolvePageReady = null
      }
    })
    if (process.env.ELECTRON_RENDERER_URL) {
      void target.loadURL(process.env.ELECTRON_RENDERER_URL + '/voice-out.html')
    } else {
      void target.loadFile(join(__dirname, '../renderer/voice-out.html'))
    }
    await this.pageReady
    return target
  }

  async play(request: VoiceOutPlayRequest): Promise<void> {
    const win = await this.ensure()
    win.webContents.send(IPC.VOICE_OUT_PLAY, request)
  }

  start(requestId: number): void {
    if (this.win && !this.win.isDestroyed()) {
      this.win.webContents.send(IPC.VOICE_OUT_START, requestId)
    }
  }

  onReady(listener: (report: VoiceOutReadyReport) => void): () => void {
    this.readyListeners.add(listener)
    return () => this.readyListeners.delete(listener)
  }

  onEnded(listener: (report: VoiceOutEndedReport) => void): () => void {
    this.endedListeners.add(listener)
    return () => this.endedListeners.delete(listener)
  }
}

let manager: VoiceOutWindowManager | null = null

export function getVoiceOutWindow(): VoiceOutWindowManager {
  if (!manager) manager = new VoiceOutWindowManager()
  return manager
}
