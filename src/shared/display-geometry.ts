import type { OverlayGeometry } from './ipc'

/**
 * 每块屏幕各记各的浮层几何（#101）。
 *
 * 之前只有一份 `overlayBounds`：笔记本接着外接屏、把浮层拖到副屏摆好，拔掉外接屏再插回来，
 * 它要么回到主屏原位（看着像「白拖了」），要么留在已经有别的窗口占着的坐标上。
 * 所以记忆按屏幕分家，记的那块屏幕不在了就**整块**落回主屏可见区——
 * 不是「留 80 像素抓手」那种半截露头，那种在只有一块屏幕时看起来就像窗口丢了。
 */
export interface DisplayFacts {
  /** Electron 的 `Display.id` 转成字符串（它是个数字，但跨会话不保证稳定）。 */
  id: string
  workArea: OverlayGeometry
  primary: boolean
}

/** 屏幕 id → 该屏幕上的几何。保留插入顺序，用来决定超限时先丢谁。 */
export type BoundsMemory = Readonly<Record<string, OverlayGeometry>>

/** 最多记 8 块屏幕：再多就是「一年前用过的投影仪」，留着只会让设置文件读不懂。 */
export const BOUNDS_MEMORY_KEEP = 8

/**
 * 旧版本那份「唯一一份几何」搬进新表时用的键。
 *
 * 它不对应任何真实屏幕：拿它查屏幕永远查不到，于是自然走「记的屏幕不在了 → 落回主屏」那条路，
 * 正好是升级后该发生的事，不需要单独写一段迁移逻辑。
 */
export const LEGACY_BOUNDS_KEY = 'previous'

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

/** 两块矩形的交集面积；用来判断某个窗口当前主要在谁身上。 */
export function overlapArea(a: OverlayGeometry, b: OverlayGeometry): number {
  const width = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
  const height = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y)
  if (width <= 0 || height <= 0) return 0
  return width * height
}

/** 窗口当前主要落在那块屏幕上；一处都不沾（比如屏幕全换了）返回 null。 */
export function displayOwning(bounds: OverlayGeometry, displays: readonly DisplayFacts[]): DisplayFacts | null {
  let best: DisplayFacts | null = null
  let bestArea = 0
  for (const display of displays) {
    const area = overlapArea(bounds, display.workArea)
    if (area > bestArea) {
      best = display
      bestArea = area
    }
  }
  return best
}

export function primaryDisplay(displays: readonly DisplayFacts[]): DisplayFacts | null {
  return displays.find((display) => display.primary) ?? displays[0] ?? null
}

/**
 * 把几何**整块**装进工作区：先压尺寸，再挪位置。
 *
 * 与 `clampGeometry` 的区别是这里不留抓手——KEEP_VISIBLE_PX 那套是为「用户拖出屏幕」设计的，
 * 而「记的屏幕没了」是系统事件，人没做错什么，给他一个半截露头的窗口等于让他再找一次。
 */
export function fitInside(bounds: OverlayGeometry, workArea: OverlayGeometry): OverlayGeometry {
  const width = clamp(Math.round(bounds.width), 1, workArea.width)
  const height = clamp(Math.round(bounds.height), 1, workArea.height)
  return {
    x: clamp(Math.round(bounds.x), workArea.x, workArea.x + workArea.width - width),
    y: clamp(Math.round(bounds.y), workArea.y, workArea.y + workArea.height - height),
    width,
    height
  }
}

export interface BoundsPlan {
  /** 该用的几何；`null` = 这块屏幕上从来没记过，调用方走默认摆放。 */
  geometry: OverlayGeometry | null
  display: DisplayFacts
  landed: 'remembered' | 'primary'
}

/**
 * 这块屏幕上该用哪份几何。
 *
 * - 记过的屏幕还在 → 用它记的，夹进它的工作区（`landed: 'remembered'`）；
 * - 记过的屏幕不在了 / 从没记过 → 用主屏，且**整块**装进去（`landed: 'primary'`）。
 */
export function planBounds(
  memory: BoundsMemory,
  displays: readonly DisplayFacts[],
  anchor?: { key: string | null; point?: { x: number; y: number } | null }
): BoundsPlan | null {
  const primary = primaryDisplay(displays)
  if (primary === null) return null
  const key = anchor?.key ?? keyAt(memory, displays, anchor?.point ?? null) ?? (memory[primary.id] === undefined ? null : primary.id)
  const remembered = key === null ? undefined : memory[key]
  if (key === null || remembered === undefined) {
    return { geometry: null, display: primary, landed: 'primary' }
  }
  const owner = displays.find((display) => display.id === key)
  if (owner === undefined) {
    // 记的那块屏幕不在了：落到主屏，整块装进去。尺寸也压一次——副屏可能比主屏大。
    return { geometry: fitInside(remembered, primary.workArea), display: primary, landed: 'primary' }
  }
  return { geometry: fitInside(remembered, owner.workArea), display: owner, landed: 'remembered' }
}

/** 按窗口当前位置找它是哪块屏幕的（派单入口的辅助，独立出来方便探针喂坐标）。 */
export function keyAt(
  memory: BoundsMemory,
  displays: readonly DisplayFacts[],
  point: { x: number; y: number } | null
): string | null {
  if (point === null) {
    // 没给坐标时（首帧、重开）表里唯一那条如果正好对应现存屏幕，就用它；两条以上交给主屏那条。
    const known = Object.keys(memory).filter((key) => displays.some((display) => display.id === key))
    return known.length === 1 ? known[0] : null
  }
  const hit = displays.find(
    (display) =>
      point.x >= display.workArea.x &&
      point.x < display.workArea.x + display.workArea.width &&
      point.y >= display.workArea.y &&
      point.y < display.workArea.y + display.workArea.height
  )
  return hit?.id ?? null
}

/** 记一块屏幕的几何；超过上限先丢最早记的（插入顺序即先后）。 */
export function rememberBounds(
  memory: BoundsMemory,
  key: string,
  geometry: OverlayGeometry,
  keep = BOUNDS_MEMORY_KEEP
): BoundsMemory {
  if (key === '') return memory
  const next: Record<string, OverlayGeometry> = { ...memory, [key]: geometry }
  const keys = Object.keys(next)
  for (const stale of keys.slice(0, Math.max(0, keys.length - keep))) delete next[stale]
  return next
}

/** 忘掉一块屏幕（用户点了「还原」时只有当前屏幕该被忘掉，别的屏幕不该跟着丢）。 */
export function forgetBounds(memory: BoundsMemory, key: string): BoundsMemory {
  if (memory[key] === undefined) return memory
  const next = { ...memory }
  delete next[key]
  return next
}

/** 一句话说清「现在这份几何是哪来的」，面板与日志共用（别各写一份口径）。 */
export function boundsPlanLine(plan: BoundsPlan): string {
  if (plan.landed === 'primary' && plan.geometry === null) {
    return `还没在这块屏幕上摆过浮层：按默认位置放在主屏（${plan.display.id}）`
  }
  if (plan.landed === 'primary') {
    return `上次摆浮层的那块屏幕不在了：整块挪回主屏（${plan.display.id}），位置与尺寸都夹进它的可见区`
  }
  return `浮层位置来自这块屏幕（${plan.display.id}）上次摆的地方`
}
