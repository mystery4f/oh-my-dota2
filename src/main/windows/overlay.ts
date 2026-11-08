import { BrowserWindow, Rectangle, screen } from 'electron'
import { join } from 'node:path'
import {
  IPC,
  type OverlayGeometry,
  type OverlayStatus,
  type OverlayTextMode
} from '@shared/ipc'
import { broadcastToWindows } from './broadcast'
import { loadSettings, saveSettings } from '../services/settings'
import { clampGeometry, miniGeometry, shouldIgnoreMouse, snapToEdges } from '@shared/overlay-geometry'
import { overlayStateFromSettings, reduceOverlay, type OverlayEvent, type OverlayState } from '@shared/overlay-state'
import { formatAccelerator } from '@shared/hotkeys'

/** 配置态（可拖可点）闲置多久后自动锁回穿透。 */
const CONFIG_IDLE_MS = 5000
const OVERLAY_WIDTH = 340
const OVERLAY_GAP = 12

/**
 * Transparent always-on-top window that mirrors the bilingual capture stream
 * next to the chat region. Click-through mode uses setIgnoreMouseEvents with
 * forwarding so the game underneath keeps receiving input.
 */

class OverlayManager {
  private win: BrowserWindow | null = null
  /** 浮层自有状态全走纯缝 reduceOverlay（#31）；这里只存当前值并执行效果。 */
  private s: OverlayState = overlayStateFromSettings(loadSettings())
  private statusListeners = new Set<(state: OverlayStatus) => void>()
  /** 上次语音录制的热键触发时刻：挡键盘自动重复的连发（见 toggleVoiceCapture）。 */
  private lastVoiceToggleAt = 0
  /** 配置态闲置计时器：解锁后放着不管，自动回到穿透，避免忘了锁定后在游戏里误点。 */
  private idleTimer: NodeJS.Timeout | null = null
  /** 一次性提示的到期时刻：在这之前，每拍 2 秒的「为什么没字」不许把它盖掉。 */
  private flashUntil = 0
  private flashTimer: NodeJS.Timeout | null = null

  /**
   * 状态策略走纯缝（reduceOverlay），这里只执行效果：落盘、闲置表、穿透、广播。
   * sync 在「状态已更新、广播未发」的窗口里跑窗口编排（setBounds/show/focus），
   * 保证广播出去的 geometry 就是窗口此刻的真实 bounds。
   */
  private commit(event: OverlayEvent, sync?: () => void): OverlayStatus {
    const reduction = reduceOverlay(event, this.s)
    this.s = reduction.state
    if (Object.keys(reduction.persist).length > 0) saveSettings(reduction.persist)
    if (reduction.idle === 'arm') this.armIdle()
    else if (reduction.idle === 'clear') this.clearIdle()
    if (reduction.clickThrough) this.applyClickThrough()
    sync?.()
    if (reduction.changed) this.broadcast()
    return this.status()
  }

  status(): OverlayStatus {
    // 一次读出整份设置：朗读开关和五个键名都来自它，别每行各读一遍文件。
    const settings = loadSettings()
    return {
      visible: this.win !== null && this.win.isVisible(),
      textMode: this.s.textMode,
      panelOpen: this.s.panelOpen,
      locked: this.s.locked,
      collapsed: this.s.collapsed,
      readAloud: settings.ttsReadAloud,
      opacity: this.s.opacity,
      geometry: this.currentGeometry(),
      hint: this.s.hint,
      // 浮层要写的键随状态一起下发：它拿不到设置，键名只能从主进程带过去。
      hotkeys: {
        overlayToggle: formatAccelerator(settings.hotkeys.overlayToggle),
        overlayLock: formatAccelerator(settings.hotkeys.overlayLock),
        overlayCollapse: formatAccelerator(settings.hotkeys.overlayCollapse),
        overlayPanel: formatAccelerator(settings.hotkeys.overlayPanel),
        voiceCapture: formatAccelerator(settings.hotkeys.voiceCapture)
      },
      quickPhrases: settings.quickPhrases
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
    // 要展开就按「收起/展开」热键（全局热键，不依赖点得到）或先解锁。
    const ignore = shouldIgnoreMouse(this.s.locked, this.s.panelOpen)
    this.win.setIgnoreMouseEvents(ignore, { forward: true })
    // 防截屏默认开着（否则手动截图会把浮层自己的行 OCR 回来再翻一遍），
    // 但 WDA_EXCLUDEFROMCAPTURE 在 Windows 上会让窗口收不到部分鼠标事件——
    // 解锁本来就是「我要操作它」的时刻，这时候关掉防护；锁定时再打开。
    this.win.setContentProtection(this.s.locked)
  }

  setOpacity(value: number): OverlayStatus {
    return this.commit({ type: 'set-opacity', value })
  }

  /** 工具条上的朗读开关：改的是同一条设置，重启后仍然记住。 */
  setVoice(read: boolean): OverlayStatus {
    return this.commit({ type: 'set-voice', read })
  }

  /** 收起成小图标 / 展开回原位。收起不改用户记住的几何，展开照原样回去。 */
  toggleCollapse(): OverlayStatus {
    if (!this.win) this.win = this.createWindow()
    if (!this.s.collapsed) {
      const win = this.win
      const at = this.currentGeometry()
      this.commit({ type: 'collapse', geometryAtCollapse: at }, () => {
        win.setBounds(miniGeometry(this.s.expandedBounds ?? at, this.workArea()))
      })
    } else {
      const win = this.win
      this.commit({ type: 'expand' }, () => {
        // 展开也要夹：收起期间可能换了分辨率，直接回首旧坐标会落到屏幕外。
        if (this.s.custom) win.setBounds(clampGeometry(this.s.custom, this.workArea()))
        else this.reposition()
      })
    }
    return this.status()
  }

  setLocked(locked: boolean): OverlayStatus {
    return this.commit({ type: 'set-locked', locked })
  }

  /** 主进程每拍算一次「为什么没字」，只有变化时才广播，避免刷 IPC。 */
  setHint(hint: string | null): void {
    // 一次性提示还没到期：周期提示先让路，否则「翻译失败」这条活不过 2 秒就被覆盖。
    if (this.flashUntil > Date.now()) return
    this.commit({ type: 'set-hint', hint })
  }
  /**
   * 一次性提示（直发失败的原因）：到期前压住周期提示，到点自己清空。
   * 浮层没开就直接丢 —— 报个错不值得为它把浮层弹出来。
   */
  flashHint(text: string, ms = 6_000): void {
    if (!this.win) return
    this.flashUntil = Date.now() + ms
    this.commit({ type: 'set-hint', hint: text })
    if (this.flashTimer) clearTimeout(this.flashTimer)
    this.flashTimer = setTimeout(() => {
      this.flashTimer = null
      this.flashUntil = 0
      this.commit({ type: 'set-hint', hint: null })
    }, ms)
  }

  /** 设置变了但窗口自身状态没变（例如刚改完热键）：重发一次，让浮层上的键名跟上。 */
  refreshStatus(): void {
    this.broadcast()
  }

  /**
   * 配置态闲置回退：解锁是「临时操作窗口」，不是常驻状态。
   * 用户拖完就去看游戏了，很可能忘了锁定——那样浮层会一直吃鼠标。
   */
  private armIdle(): void {
    this.clearIdle()
    if (this.s.locked || this.s.panelOpen) return
    this.idleTimer = setTimeout(() => {
      this.idleTimer = null
      if (this.s.locked || this.s.panelOpen) return
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
    if (this.s.locked) return this.status()
    const base = this.currentGeometry()
    return this.applyGeometry({ x: base.x + dx, y: base.y + dy })
  }

  /** 拖动结束的贴边吸附：拖完留下 1~2px 缝隙，换 DPI 就变成一条亮边。 */
  snap(): OverlayStatus {
    if (this.s.locked) return this.status()
    return this.applyGeometry(snapToEdges(this.currentGeometry(), this.workArea()))
  }

  /** 拖动/拉伸：patch 只带要改的字段，坐标由渲染层按起点算好再传。 */
  applyGeometry(patch: Partial<OverlayGeometry>): OverlayStatus {
    if (!this.win) this.win = this.createWindow()
    if (this.s.collapsed) {
      // 收起时窗口只有 132x34，clampGeometry 的 240x120 下限会把它当场撑大；
      // 只挪展开记忆的原点：拖到哪，展开就从哪长出来。
      const win = this.win
      const base = this.s.expandedBounds ?? this.currentGeometry()
      const origin = {
        x: Math.round(patch.x ?? base.x),
        y: Math.round(patch.y ?? base.y)
      }
      return this.commit(
        { type: 'move-collapsed-origin', origin, expandedBounds: base, custom: this.s.custom },
        () => {
          win.setBounds(miniGeometry(this.s.expandedBounds ?? base, this.workArea()))
        }
      )
    }
    const next = clampGeometry({ ...this.currentGeometry(), ...patch }, this.workArea())
    const win = this.win
    return this.commit({ type: 'set-custom-geometry', geometry: next }, () => {
      win.setBounds(next)
    })
  }

  /** 还原：回到跟着捕获区域走的默认摆放，并清掉记住的几何。 */
  resetGeometry(): OverlayStatus {
    return this.commit({ type: 'reset-custom-geometry' }, () => {
      this.reposition()
    })
  }

  /**
   * 呼出面板热键：浮层临时变成可交互面板（历史/快捷短语/AI 建议）。
   * panelOpen 期间接鼠标、不回锁；再按一次或 Esc 关闭，恢复原状态（锁定→穿透）。
   */
  togglePanel(): OverlayStatus {
    const open = !this.s.panelOpen
    if (open && !this.win) this.win = this.createWindow()
    const win = this.win
    return this.commit({ type: 'set-panel', open }, () => {
      if (!open) {
        // 关闭即还键盘给游戏；穿透恢复由 applyClickThrough 完成。
        win?.blur()
        return
      }
      this.reposition()
      win?.show()
      win?.moveTop()
      win?.focus()
    })
  }
  /** Ask the overlay window to start or stop microphone capture (hotkey driven). */
  toggleVoiceCapture(): void {
    // 按住不松会触发键盘自动重复（WM_HOTKEY 连发），一次长按 = 起录/停录疯狂翻面，
    // 最后多半落在「录音太短已忽略」——观感就是「热键没效果」。500ms 内的连发一律当同一次。
    const now = Date.now()
    if (now - this.lastVoiceToggleAt < 500) return
    this.lastVoiceToggleAt = now
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
      // 藏起来要跨启动记住：用户明确按了「显示/隐藏浮层」，下次启动就别自己蹦出来。
      return this.commit({ type: 'set-visible', visible: false })
    }
    this.show()
    return this.status()
  }

  setText(mode: OverlayTextMode): OverlayStatus {
    return this.commit({ type: 'set-text', mode })
  }

  show(): void {
    if (!this.win) this.win = this.createWindow()
    this.reposition()
    // 上次以「收起的小图标」退出：这次见面也应该是小图标，不该突然整块砸出来。
    if (this.s.collapsed) {
      const collapsedAt = this.s.expandedBounds ?? this.currentGeometry()
      this.s = { ...this.s, expandedBounds: collapsedAt }
      this.win.setBounds(miniGeometry(collapsedAt, this.workArea()))
    }
    this.applyClickThrough()
    // Windows 上透明窗口在某些路径（show / setBounds 之后）会退回不透明底，
    // 每次显示都重新声明一次全透明背景，是代价最小且不伤性能的兜底。
    this.win.setBackgroundColor('#00000000')
    this.win.showInactive()
    // 显示状态跨启动记住（「记忆隐藏」）：这次亮出来，下次启动也亮出来。
    if (!loadSettings().overlayVisible) this.commit({ type: 'set-visible', visible: true })
    else this.broadcast()
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
    win.setContentProtection(this.s.locked)
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
    if (this.s.collapsed) return
    const wa = this.workArea()
    this.win.setBounds(this.s.custom ? clampGeometry(this.s.custom, wa) : this.defaultGeometry(wa))
  }

  private workArea(): Rectangle {
    return screen.getPrimaryDisplay().workArea
  }

  private broadcast(): void {
    const state = this.status()
    broadcastToWindows(IPC.OVERLAY_STATE, state)
    for (const callback of this.statusListeners) callback(state)
  }
}

let manager: OverlayManager | null = null

export function getOverlayManager(): OverlayManager {
  if (!manager) manager = new OverlayManager()
  return manager
}
