/**
 * 整块淡入的落地（#102）：判定在 `@shared/overlay-motion`，这里只负责把时间轴交给 CSS 过渡。
 *
 * 用过渡而不是动画：数据已经到了 1 就什么都不做，天然满足「中途又来新行，跳到终态、
 * 不清掉已经显示的内容」；动画要重放就得先回到 0，正好是反的。
 */
import { FADE_MS, shouldFade, type FadeTriggerInput } from '@shared/overlay-motion'

/** 跨多次调用要记住的东西：上一次淡的时刻（安静期用它算）。 */
export interface BlockFadeState {
  lastAt: number
}

export const newBlockFadeState = (): BlockFadeState => ({ lastAt: 0 })

/** 系统偏好减少动态效果：这种机器上一律不淡，直接出现（CSS 那边还有一条媒体查询管入场动画）。 */
export function reducedMotionNow(): boolean {
  return (
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/**
 * 该淡就淡，返回是否真的动了。
 * 先写 0（不带过渡）再强制一次重排，然后放开过渡写 1——同一帧里直接 0→1 会被浏览器合并，什么也看不见。
 */
export function playBlockFade(
  node: HTMLElement | null,
  input: FadeTriggerInput,
  state: BlockFadeState,
  now = Date.now()
): boolean {
  if (node === null) return false
  if (!shouldFade({ ...input, sinceLastMs: now - state.lastAt, reducedMotion: reducedMotionNow() }))
    return false
  state.lastAt = now
  node.style.transition = 'none'
  node.style.opacity = '0'
  void node.offsetHeight
  node.style.transition = `opacity ${FADE_MS}ms ease-out`
  node.style.opacity = '1'
  return true
}
