import type { OverlayStatus } from '@shared/ipc'
import { moveBy, resizeFromLeft, resizeFromRight } from '@shared/overlay-geometry'

export type DragKind = 'move' | 'left' | 'right'

/** 主进程 clamp 之外的宽容边界：拖到哪算哪，clamp 由主进程兜底。 */
const UNBOUNDED = { x: -100000, y: -100000, width: 200000, height: 200000 }

/** 这一指有没有真的拖动：mini 图标靠它区分「点一下展开」和「拖走」。 */
let lastDragMoved = false

export function consumeDragMoved(): boolean {
  const moved = lastDragMoved
  lastDragMoved = false
  return moved
}
/**
 * 拖动/缩放入口：需要当前几何做增量基准。
 * 增量发给主进程算（clamp、贴边都归它），这边只管 rAF 节流；
 * 松手先 snap 再 resync：主进程 clamp 过的才是真值，标签不能显示手算的中间态。
 */
export function beginDrag(
  status: OverlayStatus,
  kind: DragKind,
  event: PointerEvent,
  onStatus: (status: OverlayStatus) => void
): void {
  lastDragMoved = false
  if (status.locked || event.button !== 0) return
  event.preventDefault()
  const start = status.geometry
  const startX = event.screenX
  const startY = event.screenY
  let frame = 0
  let next: { x: number; y: number; width: number; height: number } | null = null
  const flush = (): void => {
    frame = 0
    if (!next) return
    const patch = next
    next = null
    void window.api.overlaySetGeometry(patch).then(onStatus)
  }
  const onMove = (move: PointerEvent): void => {
    const dx = move.screenX - startX
    const dy = move.screenY - startY
    if (Math.abs(dx) > 3 || Math.abs(dy) > 3) lastDragMoved = true
    next =
      kind === 'move'
        ? moveBy(start, dx, dy, UNBOUNDED)
        : kind === 'left'
          ? resizeFromLeft(start, dx, UNBOUNDED)
          : resizeFromRight(start, dx, UNBOUNDED)
    if (frame === 0) frame = requestAnimationFrame(flush)
  }
  const onUp = (): void => {
    window.removeEventListener('pointermove', onMove)
    window.removeEventListener('pointerup', onUp)
    if (frame !== 0) cancelAnimationFrame(frame)
    flush()
    // 松手那一刻贴边：拖得再准也会留 1~2px 缝，换 DPI 就成一条亮边。
    void window.api.overlaySnap().then(onStatus)
    void window.api.overlayStatus().then(onStatus)
  }
  window.addEventListener('pointermove', onMove)
  window.addEventListener('pointerup', onUp)
}
