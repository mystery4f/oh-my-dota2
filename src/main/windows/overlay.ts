import { BrowserWindow, Rectangle, screen } from 'electron'
import { join } from 'node:path'
import {
  IPC,
  type OverlayGeometry,
  type OverlayStatus,
  type OverlayTextMode
} from '@shared/ipc'
import { loadSettings, saveSettings } from '../services/settings'
import { clampGeometry, miniGeometry, shouldIgnoreMouse, snapToEdges } from '@shared/overlay-geometry'

/** 配置态（可拖可点）闲置多久后自动锁回穿透。 */
const CONFIG_IDLE_MS = 5000
const OVERLAY_WIDTH = 340
const OVERLAY_GAP = 12

/**
 * Transparent always-on-top window that mirrors the bilingual capture stream
 * next to the chat region. Click-through mode uses setIgnoreMouseEvents with
 * forwarding so the game underneath keeps receiving input.
 */
const OPACITY_MIN = 0.05
const OPACITY_MAX = 0.9

/** 夹住区间：手抖输个 5 或者 -1 都不该让整块底色消失或全黑。 */
function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return 0.34
  return Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, value))
}

class OverlayManager {
  private win: BrowserWindow | null = null
  /** 默认只显示译文：译文没到时先占位显示原文，到达后就地换掉。 */
  private textMode: OverlayTextMode = loadSettings().overlayText
  private replyOpen = false
  /** 锁定时几何冻住、强制穿透；解锁是为了能拖能改大小。 */
  private locked = loadSettings().overlayLocked
  /** 行底色不透明度；只影响每一行的底，不影响窗口本身的透明。 */
  private opacity = clampOpacity(loadSettings().overlayOpacity)
  /** 用户调过的几何；null 表示跟着捕获区域自动摆。 */
  private custom: OverlayGeometry | null = loadSettings().overlayBounds
  /** 收起 = 缩成小图标。收起前的几何记在这里，展开时原样回去。跨启动记住（overlayCollapsed）。 */
  private collapsed = loadSettings().overlayCollapsed
  private expandedBounds: OverlayGeometry | null = null
  private statusListeners = new Set<(state: OverlayStatus) => void>()
  /** 为什么取不到字；null = 一切正常，浮层上不显示任何提示。 */
  private hint: string | null = null
  /** 配置态闲置计时器：解锁后放着不管，自动回到穿透，避免忘了锁定后在游戏里误点。 */
  private idleTimer: NodeJS.Timeout | null = null

  status(): OverlayStatus {
    return {
      visible: this.win !== null && this.win.isVisible(),
      textMode: this.textMode,
      replyOpen: this.replyOpen,
      locked: this.locked,
      collapsed: this.collapsed,
      readAloud: loadSettings().ttsReadAloud,
      opacity: this.opacity,
      geometry: this.currentGeometry(),
      hint: this.hint
    }
  }

  /** 浮层此刻的实际几何：还没开窗时按默认方位算，别让调用方拿到假数据。 */
  currentGeometry(): OverlayGeometry {
    if (this.win) return this.win.getBounds()
    return this.defaultGeometry(this.workArea())
  }

  /**
   * 穿透只由锁定决定：锁定 = 不挡游戏，解锁 = 能拖能点。
   * 曾经还有一个独立的「点击穿透」开关，结果解锁后依旧穿透、拖不动——
   * 两个开关描述同一件事，用户永远猜不到要关哪个。
   */
  private applyClickThrough(): void {
    if (!this.win) return
    // 锁定 / 解锁对收起的小图标同样生效：锁定就穿透，防误点；
    // 要展开就按 Alt+Shift+B（全局热键，不依赖点得到）或先按 Alt+Shift+P 解锁。
    const ignore = shouldIgnoreMouse(this.locked, this.replyOpen)
    this.win.setIgnoreMouseEvents(ignore, { forward: true })
    // 防截屏默认开着（否则手动截图会把浮层自己的行 OCR 回来再翻一遍），
    // 但 WDA_EXCLUDEFROMCAPTURE 在 Windows 上会让窗口收不到部分鼠标事件——
    // 解锁本来就是「我要操作它」的时刻，这时候关掉防护；锁定时再打开。
    this.win.setContentProtection(this.locked)
  }

  setOpacity(value: number): OverlayStatus {
    this.opacity = clampOpacity(value)
    saveSettings({ overlayOpacity: this.opacity })
    this.broadcast()
    return this.status()
  }

  /** 工具条上的朗读开关：改的是同一条设置，重启后仍然记住。 */
  setVoice(read: boolean): OverlayStatus {
    saveSettings({ ttsReadAloud: read })
    this.broadcast()
    return this.status()
  }

  /** 收起成小图标 / 展开回原位。收起不改用户记住的几何，展开照原样回去。 */
  toggleCollapse(): OverlayStatus {
    if (!this.win) this.win = this.createWindow()
    if (!this.collapsed) {
      this.expandedBounds = this.currentGeometry()
      this.collapsed = true
      // 收起的意思是「这一局先别管它」：顺手锁上，图标才不会被误拖误点。
      // 锁定后照旧穿透、照旧可点——applyClickThrough 对 collapsed 网开一面。
      this.locked = true
      saveSettings({ overlayLocked: true, overlayCollapsed: true })
      this.clearIdle()
      this.win.setBounds(miniGeometry(this.expandedBounds, this.workArea()))
    } else {
      this.collapsed = false
      saveSettings({ overlayCollapsed: false })
      // 展开也要夹：收起期间可能换了分辨率，直接回首旧坐标会落到屏幕外。
      if (this.custom) this.win.setBounds(clampGeometry(this.custom, this.workArea()))
      else this.reposition()
    }
    this.applyClickThrough()
    this.broadcast()
    return this.status()
  }

  setLocked(locked: boolean): OverlayStatus {
    this.locked = locked
    saveSettings({ overlayLocked: locked })
    // 解锁 = 开始 5 秒倒计时；锁定 = 停表。
    if (locked) this.clearIdle()
    else this.armIdle()
    // 解锁就该能立刻拖：不必等用户再去关一次点击穿透。
    this.applyClickThrough()
    this.broadcast()
    return this.status()
  }

  /** 主进程每拍算一次「为什么没字」，只有变化时才广播，避免刷 IPC。 */
  setHint(hint: string | null): void {
    if (this.hint === hint) return
    this.hint = hint
    this.broadcast()
  }

  /**
   * 配置态闲置回退：解锁是「临时操作窗口」，不是常驻状态。
   * 用户拖完就去看游戏了，很可能忘了锁定——那样浮层会一直吃鼠标。
   */
  private armIdle(): void {
    this.clearIdle()
    if (this.locked || this.replyOpen) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.locked || this.replyOpen) return
      this.setLocked(true)
    }, CONFIG_IDLE_MS)
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = null
  }

  /** 渲染层在窗口上划一下就算「还在操作」，把闲置倒计时推后。 */
  keepAlive(): void {
    this.armIdle()
  }

  /** 方向键微调：1px，按 Shift 时 10px（渲染层算好增量）。 */
  nudge(dx: number, dy: number): OverlayStatus {
    if (this.locked) return this.status()
    const base = this.currentGeometry()
    this.armIdle()
    return this.applyGeometry({ x: base.x + dx, y: base.y + dy })
  }

  /** 拖动结束的贴边吸附：拖完留下 1~2px 缝隙，换 DPI 就变成一条亮边。 */
  snap(): OverlayStatus {
    if (this.locked) return this.status()
    const snapped = snapToEdges(this.currentGeometry(), this.workArea())
    this.armIdle()
    return this.applyGeometry(snapped)
  }

  /** 拖动/拉伸：patch 只带要改的字段，坐标由渲染层按起点算好再传。 */
  applyGeometry(patch: Partial<OverlayGeometry>): OverlayStatus {
    if (!this.win) this.win = this.createWindow()
    const base = this.currentGeometry()
    const next = clampGeometry({ ...base, ...patch }, this.workArea())
    this.custom = next
    saveSettings({ overlayBounds: next })
    this.win.setBounds(next)
    this.armIdle()
    this.broadcast()
    return this.status()
  }

  /** 还原：回到跟着捕获区域走的默认摆放，并清掉记住的几何。 */
  resetGeometry(): OverlayStatus {
    this.custom = null
    saveSettings({ overlayBounds: null })
    this.reposition()
    this.broadcast()
    return this.status()
  }

  /**
   * Show the reply bar and take focus. Windows grants foreground rights to the
   * thread that handled the registered hotkey, so the game yields the keyboard.
   */
  openReply(): OverlayStatus {
    if (!this.win) this.win = this.createWindow()
    this.replyOpen = true
    this.reposition()
    this.win.setIgnoreMouseEvents(false)
    this.win.show()
    this.win.moveTop()
    this.win.focus()
    this.broadcast()
    this.win.webContents.send(IPC.OVERLAY_REPLY, true)
    return this.status()
  }

  /** Close the reply bar; `submitted` hands focus back to the game for Ctrl+V. */
  closeReply(submitted = false): OverlayStatus {
    this.replyOpen = false
    if (this.win) {
      this.win.webContents.send(IPC.OVERLAY_REPLY, false)
      this.applyClickThrough()
      if (submitted) this.win.blur()
    }
    this.broadcast()
    return this.status()
  }

  /** Ask the overlay window to start or stop microphone capture (hotkey driven). */
  toggleVoiceCapture(): void {
    if (!this.win) this.win = this.createWindow()
    if (!this.win.isVisible()) this.show()
    this.win.webContents.send(IPC.VOICE_RECORD_TOGGLE)
  }

  /** Subscribe to status changes (tray menu, dashboard cues). */
  onStatusChange(callback: (state: OverlayStatus) => void): () => void {
    this.statusListeners.add(callback)
    return () => this.statusListeners.delete(callback)
  }

  toggle(): OverlayStatus {
    if (this.status().visible) {
      this.win?.hide()
      // 藏起来要跨启动记住：用户明确按了 Alt+Shift+O，下次启动就别自己蹦出来。
      saveSettings({ overlayVisible: false })
    } else {
      this.show()
    }
    this.broadcast()
    return this.status()
  }

  setText(mode: OverlayTextMode): OverlayStatus {
    this.textMode = mode
    saveSettings({ overlayText: mode })
    this.broadcast()
    return this.status()
  }

  show(): void {
    if (!this.win) this.win = this.createWindow()
    this.reposition()
    // 上次以「收起的小图标」退出：这次见面也应该是小图标，不该突然整块砸出来。
    if (this.collapsed) {
      this.expandedBounds = this.expandedBounds ?? this.currentGeometry()
      this.win.setBounds(miniGeometry(this.expandedBounds, this.workArea()))
    }
    this.applyClickThrough()
    // Windows 上透明窗口在某些路径（show / setBounds 之后）会退回不透明底，
    // 每次显示都重新声明一次全透明背景，是代价最小且不伤性能的兜底。
    this.win.setBackgroundColor('#00000000')
    this.win.showInactive()
    // 显示状态跨启动记住（「记忆隐藏」）：这次亮出来，下次启动也亮出来。
    if (!loadSettings().overlayVisible) saveSettings({ overlayVisible: true })
    this.broadcast()
  }

  get window(): BrowserWindow | null {
    return this.win
  }

  destroy(): void {
    this.win?.destroy()
    this.win = null
  }

  private createWindow(): BrowserWindow {
    const win = new BrowserWindow({
      width: OVERLAY_WIDTH,
      height: 420,
      transparent: true,
      frame: false,
      resizable: false,
      maximizable: false,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        sandbox: false,
        contextIsolation: true
      }
    })
    win.setAlwaysOnTop(true, 'screen-saver')
    // 初始状态跟随锁定：锁定态（默认）开着防截屏，解锁后由 applyClickThrough 关掉。
    win.setContentProtection(this.locked)
    win.on('closed', () => {
      this.win = null
    })
    if (process.env.ELECTRON_RENDERER_URL) {
      void win.loadURL(process.env.ELECTRON_RENDERER_URL + '/overlay.html')
    } else {
      void win.loadFile(join(__dirname, '../renderer/overlay.html'))
    }
    return win
  }

  /** 默认摆放：贴屏幕右侧。抓屏移除后没有「聊天区域」可跟，只剩屏幕自己。 */
  private defaultGeometry(wa: Rectangle): OverlayGeometry {
    return clampGeometry(
      {
        x: wa.x + wa.width - OVERLAY_WIDTH - OVERLAY_GAP,
        y: wa.y + OVERLAY_GAP,
        width: OVERLAY_WIDTH,
        height: Math.min(420, wa.height - OVERLAY_GAP * 2)
      },
      wa
    )
  }

  /**
   * 用户亲手拖过的几何优先；没拖过才跟着捕获区域走。
   * 这样换区域不会把手工排版冲掉，想回到默认就点「还原」。
   */
  private reposition(): void {
    if (!this.win) return
    // 收起状态下窗口只有 132x34：此时重算几何会把它瞬间撑回全尺寸，小图标就废了。
    if (this.collapsed) return
    const wa = this.workArea()
    this.win.setBounds(this.custom ? clampGeometry(this.custom, wa) : this.defaultGeometry(wa))
  }

  private workArea(): Rectangle {
    return screen.getPrimaryDisplay().workArea
  }

  private broadcast(): void {
    const state = this.status()
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.OVERLAY_STATE, state)
    for (const callback of this.statusListeners) callback(state)
  }
}

let manager: OverlayManager | null = null

export function getOverlayManager(): OverlayManager {
  if (!manager) manager = new OverlayManager()
  return manager
}
