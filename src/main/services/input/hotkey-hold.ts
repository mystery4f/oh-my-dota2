import { spawn, type ChildProcess } from 'node:child_process'
import scriptSource from './hotkey-hold.ps1?raw'
import { deployPsScript } from './ps-runner'
import {
  noteHoldEdge,
  noteHoldFallback,
  noteHoldReady,
  noteHoldRetry,
  noteHoldStarting,
  noteHoldStopped
} from './hold-selftest'

/**
 * 按住检测：常驻一个 PowerShell 进程，40ms 轮询组合键的 GetAsyncKeyState。
 *
 * Electron 的 globalShortcut 只通知「按下」，不通知「松开」，而按住说话要的恰恰是松开——
 * 不知道松开的时刻就不知道何时停录。低层键盘钩子事件更漂亮，但钩子会被游戏和反作弊软件
 * 盯上；这里只盯一组键，25Hz 轮询的开销可以忽略。
 *
 * 进程崩了按 3 秒退避重开，5 次都起不来就报 onUnavailable，由调用方退回 globalShortcut 的
 * 「敲一下」注册——热键绝不能变哑。换键只重开一次进程。
 */

export interface HoldWatchHandlers {
  onPress: () => void
  onRelease: () => void
  /** 重试 5 次仍拉不起来（PowerShell 被策略挡住、脚本被杀）：调用方应退回敲一下。 */
  onUnavailable?: () => void
}

const RETRY_MS = 3000
const MAX_ATTEMPTS = 5

/** 探针用的两个口子：把常驻进程换成一个假的，或把退避压缩到毫秒。生产代码不传。 */
export interface HoldWatchOptions {
  launch?: (vks: number[]) => ChildProcess
  retryMs?: number
}

class HoldWatcher {
  private child: ChildProcess | null = null
  private signature = ''
  private handlers: HoldWatchHandlers | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private attempts = 0
  private launcher: ((vks: number[]) => ChildProcess) | null = null
  private retryMs = RETRY_MS

  /** 开始（或换键重启）监视。同一个组合键只换处理函数，不重开进程。 */
  start(vks: number[], handlers: HoldWatchHandlers, options?: HoldWatchOptions): void {
    const signature = vks.join(',')
    if (this.child && this.signature === signature) {
      this.handlers = handlers
      return
    }
    this.stop()
    this.signature = signature
    this.handlers = handlers
    this.attempts = 0
    this.launcher = options?.launch ?? null
    this.retryMs = options?.retryMs ?? RETRY_MS
    noteHoldStarting()
    this.spawn(vks)
  }

  stop(): void {
    this.signature = ''
    this.handlers = null
    this.clearRetry()
    const child = this.child
    this.child = null
    child?.kill()
    noteHoldStopped()
  }

  private clearRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer)
    this.retryTimer = null
  }

  private spawn(vks: number[]): void {
    const handlers = this.handlers
    if (!handlers) return
    const scriptPath = deployPsScript({
      folder: 'hotkey-hold',
      scriptName: 'hotkey-hold.ps1',
      source: scriptSource
    })
    const child = this.launcher
      ? this.launcher(vks)
      : spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Vks', vks.join(',')],
          { windowsHide: true }
        )
    this.child = child
    let buffer = ''
    let ready = false
    let stderr = ''
    child.stdout?.on('data', (chunk) => {
      buffer += String(chunk)
      const lines = buffer.split(/\r?\n/)
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const text = line.trim()
        if (text === 'OK') {
          ready = true
          this.attempts = 0
          noteHoldReady()
          console.log('HOTKEY_HOLD_READY', JSON.stringify({ vks }))
        } else if (text === 'HOLD 1') {
          noteHoldEdge('press')
          this.handlers?.onPress()
        } else if (text === 'HOLD 0') {
          noteHoldEdge('release')
          this.handlers?.onRelease()
        }
      }
    })
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-400)
    })
    child.on('error', (error) => {
      if (this.child !== child) return
      console.log('HOTKEY_HOLD_ERROR', JSON.stringify({ error: error.message }))
    })
    child.on('close', (code) => {
      // 换键会先 stop 再 spawn：旧孩子收尾时不能把新孩子的引用清掉。
      if (this.child !== child) return
      this.child = null
      console.log('HOTKEY_HOLD_EXIT', JSON.stringify({ code, ready, stderr: stderr.trim() || undefined }))
      this.scheduleRetry(vks)
    })
  }

  private scheduleRetry(vks: number[]): void {
    if (!this.handlers) return
    if (this.attempts >= MAX_ATTEMPTS) {
      console.log('HOTKEY_HOLD_GIVE_UP', JSON.stringify({ attempts: this.attempts }))
      noteHoldFallback(`常驻脚本连续 ${MAX_ATTEMPTS} 次没起来（按住的松开信号收不到）`)
      this.handlers.onUnavailable?.()
      return
    }
    this.attempts += 1
    noteHoldRetry(this.attempts)
    this.clearRetry()
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null
      if (!this.handlers) return
      this.spawn(vks)
    }, this.retryMs)
  }
}

let watcher: HoldWatcher | null = null

function getWatcher(): HoldWatcher {
  if (!watcher) watcher = new HoldWatcher()
  return watcher
}

/** 用 VK 列表开始（或换键重启）按住监视。 */
export function watchHold(vks: number[], handlers: HoldWatchHandlers, options?: HoldWatchOptions): void {
  getWatcher().start(vks, handlers, options)
}

/** 停掉常驻进程（换回敲一下、退出程序时调用）。 */
export function stopHoldWatch(): void {
  watcher?.stop()
}
