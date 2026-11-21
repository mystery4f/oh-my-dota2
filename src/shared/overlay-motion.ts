/**
 * 浮层「整块淡入」的判定（#102）。
 *
 * 只有两件事算「有新东西要显示」：①浮层从收起/隐藏变成展开 ②真的有新的行进来。
 * 空转刷新、切比分、GSI 帧更新都不算——它们改的是同一条内容的状态，不是「这块内容刚出现」。
 *
 * 时长与曲线写在这里，渲染层照着用一次；CSS 里不许再抄一份（`check:pure` 会拒绝），
 * 免得两个地方各调各的，改一处不生效。
 */

/** 整块淡入的时长。比行的 `rise-in 200ms` 略短：整块叠在行入场之上，等长会显得迟钝。 */
export const FADE_MS = 160

/** 一秒内来两行只淡一次：这条安静期就是「只淡一次」的全部实现。 */
export const FADE_QUIET_MS = 1000

export type FadeTrigger = 'expanded' | 'new-lines'

/** 浮层当下的形态：看不看得见、是不是收成图标。 */
export interface OverlayPosture {
  visible: boolean
  collapsed: boolean
}

export interface FadeTriggerInput {
  /** 上一帧形态；首次渲染不知道就传 null（那一次不算「展开」）。 */
  before: OverlayPosture | null
  after: OverlayPosture
  /** 这一批真的新增了几行（同一条内容的补丁、手动刷新都不算）。 */
  newLines: number
}

export interface FadeInput extends FadeTriggerInput {
  /** 距离上一次淡入过了多久。 */
  sinceLastMs: number
  /** 系统偏好减少动态效果时为 true：一律不淡，直接出现。 */
  reducedMotion: boolean
}

const expandedOf = (before: OverlayPosture | null, after: OverlayPosture): boolean =>
  before !== null && (before.collapsed || !before.visible) && !after.collapsed && after.visible

/** 这一帧该按哪个理由淡入；两边都不是就返回 null。 */
export function fadeTriggerOf(input: FadeTriggerInput): FadeTrigger | null {
  if (expandedOf(input.before, input.after)) return 'expanded'
  if (input.newLines > 0) return 'new-lines'
  return null
}

/**
 * 到底淡不淡。展开是用户按了热键/点了图标，随时都该淡；
 * 新行走安静期，一秒内的第二行不再淡——重复淡入只会闪。
 */
export function shouldFade(input: FadeInput): boolean {
  if (input.reducedMotion) return false
  const trigger = fadeTriggerOf(input)
  if (trigger === null) return false
  if (trigger === 'expanded') return true
  return input.sinceLastMs >= FADE_QUIET_MS
}
