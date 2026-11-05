import { globalShortcut } from 'electron'
import {
  HOTKEY_ACTION_IDS,
  describeHotkeys,
  findHotkeyConflicts,
  normalizeHotkeyMap,
  type HotkeyActionId,
  type HotkeyMap
} from '@shared/hotkeys'
import type { HotkeyVerdicts, HotkeysResult } from '@shared/ipc'
import { loadSettings, saveSettings } from './settings'

/**
 * 全局热键注册服务：把「动作 → 处理函数」和「动作 → 组合键」分开管。
 *
 * 入口只交一次处理函数，之后任何一次改键都只是 apply(新表)：
 * 先全撤再全注册，并把每个键的结局（抢到 / 被别的软件占了 / 没绑）带回去给面板。
 * 全撤再注册有一个毫秒级空窗，但这几个键都是人手按的，换来的是「改完立刻生效」。
 */

/** 入口注入的动作处理函数。 */
export type HotkeyHandlers = Record<HotkeyActionId, () => void>

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
  globalShortcut.unregisterAll()
  const next: HotkeyVerdicts = {}
  for (const id of HOTKEY_ACTION_IDS) {
    const accelerator = normalized[id]
    if (!accelerator) {
      next[id] = 'unbound'
      continue
    }
    const handler = handlers?.[id]
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
