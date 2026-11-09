import { globalShortcut } from 'electron'
import {
  HOTKEY_ACTION_IDS,
  acceleratorVks,
  describeHotkeys,
  findHotkeyConflicts,
  normalizeHotkeyMap,
  type HotkeyActionId,
  type HotkeyMap
} from '@shared/hotkeys'
import type { HotkeyVerdicts, HotkeysResult } from '@shared/ipc'
import { loadSettings, saveSettings } from './settings'
import { stopHoldWatch, watchHold } from './input/hotkey-hold'

/**
 * 全局热键注册服务：把「动作 → 处理函数」和「动作 → 组合键」分开管。
 *
 * 入口只交一次处理函数，之后任何一次改键都只是 apply(新表)：
 * 先全撤再全注册，并把每个键的结局（抢到 / 被别的软件占了 / 没绑）带回去给面板。
 * 全撤再注册有一个毫秒级空窗，但这几个键都是人手按的，换来的是「改完立刻生效」。
 */

/** 入口注入的动作处理函数。 */
export type HotkeyHandlers = Record<HotkeyActionId, () => void> & {
  /** 按住模式的按下：开始录音（未提供时退回 voiceCapture 本身）。 */
  voiceCaptureStart?: () => void
  /** 按住模式的松开：结束录音并触发翻译播报。 */
  voiceCaptureStop?: () => void
}

let handlers: HotkeyHandlers | null = null
/** 上一次注册的结果：面板读热键表时连它一起显示。 */
let verdicts: HotkeyVerdicts = {}

/** 入口在 whenReady 里调用一次；重复调用只换处理函数，并按当前设置里的表重新注册。 */
export function installHotkeys(next: HotkeyHandlers): void {
  handlers = next
  applyHotkeys(loadSettings().hotkeys)
}

/**
 * 按表重注册。未绑定的动作不留痕；抢不到的键不抛错——
 * 这正是要被面板看见的那个状态，抛了就变回「按了没反应且没人知道为什么」。
 */
export function applyHotkeys(map: Partial<HotkeyMap>): HotkeyVerdicts {
  const normalized = normalizeHotkeyMap(map)
  const captureMode = loadSettings().voiceCaptureMode
  globalShortcut.unregisterAll()
  // 语音对讲切回敲一下时必须把常驻监视进程收掉，否则按住那只手还会继续录。
  if (captureMode !== 'hold') stopHoldWatch()
  const next: HotkeyVerdicts = {}
  for (const id of HOTKEY_ACTION_IDS) {
    const accelerator = normalized[id]
    if (!accelerator) {
      if (id === 'voiceCapture') stopHoldWatch()
      next[id] = 'unbound'
      continue
    }
    const handler = handlers?.[id]
    // 按住说话要的是「松开」：组合键拆成 VK 表交给常驻轮询进程，这个动作因此不注册
    // globalShortcut——两边同时监听会让一次按下既开录又被 toggle 关掉。
    if (id === 'voiceCapture' && captureMode === 'hold') {
      const vks = acceleratorVks(accelerator)
      if (vks) {
        const start = handlers?.voiceCaptureStart ?? handler
        const stop = handlers?.voiceCaptureStop
        watchHold(vks, {
          onPress: () => start?.(),
          onRelease: () => stop?.(),
          // 进程起不来就退回敲一下：宁可语义降级，也不能让热键变哑。
          onUnavailable: () => {
            console.log('HOTKEY_HOLD_FALLBACK', JSON.stringify({ action: id, accelerator }))
            if (handler) globalShortcut.register(accelerator, handler)
          }
        })
        next[id] = 'accepted'
        continue
      }
      console.log('HOTKEY_HOLD_NO_VKS', JSON.stringify({ action: id, accelerator }))
    }
    const ok = handler ? globalShortcut.register(accelerator, handler) : false
    if (!ok) console.log('HOTKEY_REGISTER_FAIL', JSON.stringify({ action: id, accelerator }))
    next[id] = ok ? 'accepted' : 'rejected'
  }
  verdicts = next
  return next
}

/** 退出前调用：撤销全部注册，免得系统里留下按了会唤醒已退出进程的键。 */
export function releaseHotkeys(): void {
  globalShortcut.unregisterAll()
  stopHoldWatch()
  verdicts = {}
}

/** 面板读：当前表 + 这次启动的注册结果。 */
export function hotkeysState(): HotkeysResult {
  // 还没注册过（探针或极早期读取）就按表本身推导结果，别把一切都画成「没抢到」。
  const effective = Object.keys(verdicts).length > 0 ? verdicts : undefined
  return { ...describeHotkeys(loadSettings().hotkeys, effective), error: null }
}

/**
 * 面板存：整张表先校验再落盘。
 * 有冲突就整张拒收并说清撞在哪个键上——半存进去只会让用户下次启动莫名少一个键。
 */
export function saveHotkeysState(input: unknown): HotkeysResult {
  const map = normalizeHotkeyMap(input)
  const conflicts = findHotkeyConflicts(map)
  if (conflicts.length > 0) {
    return {
      ...describeHotkeys(loadSettings().hotkeys, verdicts),
      error: `两个动作不能共用同一个键：${[...new Set(conflicts.map((item) => item.accelerator))].join('、')}`
    }
  }
  saveSettings({ hotkeys: map })
  return { ...describeHotkeys(map, applyHotkeys(map)), error: null }
}
