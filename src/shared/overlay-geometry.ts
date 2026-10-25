import type { OverlayGeometry } from './ipc'

/** 再窄就塞不下一行「昵称 + 译文」，再矮就连一条消息都放不下。 */
export const OVERLAY_MIN_WIDTH = 240
export const OVERLAY_MIN_HEIGHT = 120
/** 拖到屏幕外时至少留这么多像素在里面，否则窗口就找不回来了。 */
export const KEEP_VISIBLE_PX = 80
/** 收起后的小图标尺寸：只放一个图标，别占地方，所以它必须绕开下面的 240x120 下限。 */
export const MINI_WIDTH = 132
export const MINI_HEIGHT = 34

/**
 * 收起时的小图标几何：保持左上角不动，只缩尺寸，再夹回工作区内。
 * 刻意不复用 clampGeometry——那边的 240x120 下限会把小图标又撑大。
 */
export function miniGeometry(from: OverlayGeometry, workArea: Area): OverlayGeometry {
  return {
    x: clamp(Math.round(from.x), workArea.x, workArea.x + workArea.width - MINI_WIDTH),
    y: clamp(Math.round(from.y), workArea.y, workArea.y + workArea.height - MINI_HEIGHT),
    width: MINI_WIDTH,
    height: MINI_HEIGHT
  }
}

type Area = OverlayGeometry

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min
  return Math.min(Math.max(value, min), max)
}

/**
 * 把几何收进工作区：宽高压到「最小可用 ~ 工作区」之间，位置留 KEEP_VISIBLE_PX 的抓手。
 * 纯函数，探针直接喂数字断言——拖拽算错坐标是那种「只在别人机器上才复现」的 bug。
 */
export function clampGeometry(bounds: OverlayGeometry, workArea: Area): OverlayGeometry {
  const width = clamp(Math.round(bounds.width), OVERLAY_MIN_WIDTH, workArea.width)
  const height = clamp(Math.round(bounds.height), OVERLAY_MIN_HEIGHT, workArea.height)
  const minX = workArea.x - width + KEEP_VISIBLE_PX
  const maxX = workArea.x + workArea.width - KEEP_VISIBLE_PX
  const minY = workArea.y
  const maxY = workArea.y + workArea.height - KEEP_VISIBLE_PX
  return {
    x: clamp(Math.round(bounds.x), minX, maxX),
    y: clamp(Math.round(bounds.y), minY, maxY),
    width,
    height
  }
}

/** 拖顶栏：整体平移。 */
export function moveBy(bounds: OverlayGeometry, dx: number, dy: number, workArea: Area): OverlayGeometry {
  return clampGeometry({ ...bounds, x: bounds.x + dx, y: bounds.y + dy }, workArea)
}

/** 抓右把手：右边界跟着走，左边界不动。 */
export function resizeFromRight(
  bounds: OverlayGeometry,
  dx: number,
  workArea: Area
): OverlayGeometry {
  // 宽度上限是「从左边到工作区右边」，否则拉到屏幕边上还会继续变宽、溢出可见区域。
  const maxWidth = workArea.x + workArea.width - bounds.x
  const width = clamp(bounds.width + dx, OVERLAY_MIN_WIDTH, Math.min(maxWidth, workArea.width))
  return clampGeometry({ ...bounds, width }, workArea)
}

/**
 * 抓左把手：左边界跟着走，右边界钉死。
 * 所以 x 与 width 必须同时反向变化，否则一拖就会「跳一下」。
 */
export function resizeFromLeft(
  bounds: OverlayGeometry,
  dx: number,
  workArea: Area
): OverlayGeometry {
  const right = bounds.x + bounds.width
  const maxWidth = right - workArea.x
  const nextWidth = clamp(bounds.width - dx, OVERLAY_MIN_WIDTH, Math.min(maxWidth, workArea.width))
  return clampGeometry({ ...bounds, x: right - nextWidth, width: nextWidth }, workArea)
}

/**
 * 穿透规则：回复框打开时必须可点（否则粘不回去）；其余时候只听锁定的。
 * 收起成小图标不改变这条规则——收起只是变小，不是「放开鼠标」。锁定后被误点才是真麻烦。
 */
export function shouldIgnoreMouse(locked: boolean, replyOpen: boolean): boolean {
  return !replyOpen && locked
}

/** 离屏幕边多近就吸附：够近是「想贴边」，太远是「想放开」。 */
export const SNAP_PX = 24

/**
 * 拖动结束时的贴边吸附：只吸真正靠边的那一维，其余保持不动。
 * 不吸则拖完留下 1~2px 的缝隙，下一次开分辨率或换 DPI 就会看到一条亮边。
 */
export function snapToEdges(bounds: OverlayGeometry, workArea: Area, threshold = SNAP_PX): OverlayGeometry {
  const right = workArea.x + workArea.width
  const bottom = workArea.y + workArea.height
  let { x, y } = bounds
  if (Math.abs(x - workArea.x) <= threshold) x = workArea.x
  if (Math.abs(x + bounds.width - right) <= threshold) x = right - bounds.width
  if (Math.abs(y - workArea.y) <= threshold) y = workArea.y
  if (Math.abs(y + bounds.height - bottom) <= threshold) y = bottom - bounds.height
  return clampGeometry({ ...bounds, x, y }, workArea)
}
