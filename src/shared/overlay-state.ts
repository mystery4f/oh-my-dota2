/**
 * 浮层状态的纯缝（beside overlay-geometry）：锁定、收起、可见性、回复框这些开关怎么联动、
 * 哪些要落盘、要不要广播，全部在这里枚举成事件；OverlayManager 只剩效果执行器
 * （开窗、setBounds、聚焦），与 gsi.ts 的 GsiEffects 同一形状。
 * 曾两次翻车的鼠标规则（shouldIgnoreMouse）与「收起顺手锁上」都冻结在事件里，探针钉死。
 */
import type { AppSettings, OverlayGeometry, OverlayTextMode } from './ipc'

/** 浮层自有状态；窗口几何（win.getBounds）不算在内，由 manager 现查现报。 */
export interface OverlayState {
  locked: boolean
  collapsed: boolean
  replyOpen: boolean
  /** 收起前的几何；收起那一刻由 manager 把窗口几何递进来。 */
  expandedBounds: OverlayGeometry | null
  /** 用户亲手拖过的几何；null = 跟着屏幕默认摆放。 */
  custom: OverlayGeometry | null
  textMode: OverlayTextMode
  opacity: number
  /** 为什么取不到字；null = 一切正常。 */
  hint: string | null
}

export type OverlayEvent =
  | { type: 'set-locked'; locked: boolean }
  /** 收起成小图标 = 「这一局先别管它」：顺手锁上，图标才不会被误拖误点。 */
  | { type: 'collapse'; geometryAtCollapse: OverlayGeometry }
  | { type: 'expand' }
  | { type: 'set-text'; mode: OverlayTextMode }
  | { type: 'set-opacity'; value: number }
  | { type: 'set-hint'; hint: string | null }
  /** 显示/隐藏跨启动记住（「记忆隐藏」）。 */
  | { type: 'set-visible'; visible: boolean }
  /** 工具条上的朗读开关：只写设置，浮层自有状态不动。 */
  | { type: 'set-voice'; read: boolean }
  | { type: 'set-reply'; open: boolean }
  | { type: 'set-custom-geometry'; geometry: OverlayGeometry }
  | { type: 'reset-custom-geometry' }
  /** 收起状态下拖小图标：只挪展开记忆的原点，尺寸绝不过 clamp。 */
  | { type: 'move-collapsed-origin'; origin: { x: number; y: number }; expandedBounds: OverlayGeometry; custom: OverlayGeometry | null }

/** 这次归约要写进设置文件的字段；空对象 = 不写盘。 */
export type OverlayPersistPatch = Partial<
  Pick<AppSettings, 'overlayLocked' | 'overlayCollapsed' | 'overlayText' | 'overlayOpacity' | 'overlayBounds' | 'overlayVisible' | 'ttsReadAloud'>
>

export interface OverlayReduction {
  state: OverlayState
  persist: OverlayPersistPatch
  /** status() 的内容变了吗 —— 变了才值得广播一次 IPC。 */
  changed: boolean
  /** locked / replyOpen 变了才需要重算穿透与防截屏。 */
  clickThrough: boolean
  /** 解锁 = 开始闲置回锁倒计时；锁定/收起 = 拆表。 */
  idle: 'arm' | 'clear' | 'keep'
}

/** 行底色不透明度夹在区间里：手抖输个 5 或 -1 不该让整块底色消失或全黑。 */
export const OPACITY_MIN = 0.05
export const OPACITY_MAX = 0.9

export function clampOpacity(value: number): number {
  if (!Number.isFinite(value)) return 0.34
  return Math.min(OPACITY_MAX, Math.max(OPACITY_MIN, value))
}

/** 启动时从设置文件还原浮层自有状态。 */
export function overlayStateFromSettings(settings: AppSettings): OverlayState {
  return {
    locked: settings.overlayLocked,
    collapsed: settings.overlayCollapsed,
    replyOpen: false,
    expandedBounds: null,
    custom: settings.overlayBounds,
    textMode: settings.overlayText,
    opacity: clampOpacity(settings.overlayOpacity),
    hint: null
  }
}

export function reduceOverlay(event: OverlayEvent, state: OverlayState): OverlayReduction {
  switch (event.type) {
    case 'set-locked': {
      const changed = event.locked !== state.locked
      return {
        state: { ...state, locked: event.locked },
        persist: changed ? { overlayLocked: event.locked } : {},
        changed,
        clickThrough: changed,
        idle: changed ? (event.locked ? 'clear' : 'arm') : 'keep'
      }
    }
    case 'collapse':
      return {
        state: { ...state, collapsed: true, locked: true, expandedBounds: event.geometryAtCollapse },
        persist: { overlayLocked: true, overlayCollapsed: true },
        changed: !state.collapsed,
        clickThrough: true,
        idle: 'clear'
      }
    case 'expand':
      return {
        state: { ...state, collapsed: false },
        persist: { overlayCollapsed: false },
        changed: state.collapsed,
        clickThrough: false,
        idle: 'keep'
      }
    case 'set-text': {
      const changed = event.mode !== state.textMode
      return {
        state: { ...state, textMode: event.mode },
        persist: changed ? { overlayText: event.mode } : {},
        changed,
        clickThrough: false,
        idle: 'keep'
      }
    }
    case 'set-opacity': {
      const opacity = clampOpacity(event.value)
      const changed = opacity !== state.opacity
      return {
        state: { ...state, opacity },
        persist: changed ? { overlayOpacity: opacity } : {},
        changed,
        clickThrough: false,
        idle: 'keep'
      }
    }
    case 'set-hint':
      return {
        state: { ...state, hint: event.hint },
        persist: {},
        changed: event.hint !== state.hint,
        clickThrough: false,
        idle: 'keep'
      }
    case 'set-visible':
      return {
        state,
        persist: { overlayVisible: event.visible },
        changed: true,
        clickThrough: false,
        idle: 'keep'
      }
    case 'set-voice':
      return {
        state,
        persist: { ttsReadAloud: event.read },
        changed: true,
        clickThrough: false,
        idle: 'keep'
      }
    case 'set-reply': {
      const changed = event.open !== state.replyOpen
      return {
        state: { ...state, replyOpen: event.open },
        persist: {},
        changed,
        clickThrough: changed,
        idle: 'keep'
      }
    }
    case 'set-custom-geometry':
      return {
        state: { ...state, custom: event.geometry },
        persist: { overlayBounds: event.geometry },
        changed: true,
        clickThrough: false,
        idle: 'arm'
      }
    case 'reset-custom-geometry':
      return {
        state: { ...state, custom: null },
        persist: { overlayBounds: null },
        changed: true,
        clickThrough: false,
        idle: 'keep'
      }
    case 'move-collapsed-origin': {
      const expandedBounds = { ...event.expandedBounds, ...event.origin }
      const custom = event.custom === null ? null : { ...event.custom, ...event.origin }
      return {
        state: { ...state, expandedBounds, custom },
        persist: custom === null ? {} : { overlayBounds: custom },
        changed: true,
        clickThrough: false,
        idle: 'arm'
      }
    }
  }
}
