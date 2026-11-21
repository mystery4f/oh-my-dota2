/**
 * #129：半双工守卫——自己正在说话时，不要把自己的声音再听一遍。
 *
 * 为什么规则放在缝里，而不是放在某个驱动里：同传腿把英文灌进虚拟声卡，声卡就是游戏的麦克风；
 * 听的那半条腿（#127）又把系统音轨录进来。两条腿各自都没错，合起来就是一个只会自我复读的圈。
 * 唯一能同时管住两处的写法是「一句纯判断 + 一个播放窗口记账」，两边都问它。
 *
 * 这道守卫只做丢弃与记账，不做「补偿识别」：被丢的那段录音本来就是我们自己的输出，
 * 补回来只会更绕。丢了多少必须能看见，否则「全丢了」和「一次没丢」在日志里长得一样。
 */

/** 记账快照：渲染层与面板都读这个形状，所以类型放缝里而不是主进程里。 */
export interface HalfDuplexSnapshot {
  /** 现在是否处于「自己在说话」的窗口里。 */
  playing: boolean
  /** 窗口还剩多少毫秒；不在窗口里时为 0。 */
  untilMs: number
  /** 累计识别尝试与其中被丢掉的段数。 */
  total: number
  dropped: number
  line: string
}

/** 播放结束后还要继续闭嘴的尾巴：设备缓冲与回声尾音都在这段里。 */
export const HALF_DUPLEX_GRACE_MS = 400

export interface HalfDuplexInput {
  /** 播放窗口的结束时刻（毫秒时间戳）；null = 当前没有在播。 */
  playingUntil: number | null
  /** 现在（注入时钟，探针不真等）。 */
  now: number
  /** 关闭守卫时窗口一律视为已过（同传没开的时候不该有任何额外行为）。 */
  enabled?: boolean
  graceMs?: number
}

export interface HalfDuplexVerdict {
  /** true = 这段录音是我们自己的声音，直接丢。 */
  drop: boolean
  reason: 'playback' | null
  /** 距离窗口结束还有多少毫秒（≤0 表示已过）。 */
  untilMs: number
}

/** 我们的输出正在放，就不听。 */
export function judgeHalfDuplex(input: HalfDuplexInput): HalfDuplexVerdict {
  const now = Number.isFinite(input.now) ? input.now : 0
  const grace = input.graceMs ?? HALF_DUPLEX_GRACE_MS
  if (input.enabled === false || input.playingUntil === null) return { drop: false, reason: null, untilMs: 0 }
  const untilMs = input.playingUntil + grace - now
  if (untilMs <= 0) return { drop: false, reason: null, untilMs: 0 }
  return { drop: true, reason: 'playback', untilMs }
}

/** 播放窗口推进一次；返回新的窗口结束时刻。同一段里多次调用只延长，不缩短。 */
export function extendPlaybackWindow(current: number | null, at: number, durationMs: number): number {
  const end = at + Math.max(0, Number.isFinite(durationMs) ? durationMs : 0)
  if (current === null) return end
  return Math.max(current, end)
}

/** 窗口结束时立刻归零（不留下一个永远不会过期的旧窗口）。 */
export function expireWindow(current: number | null, now: number): number | null {
  if (current === null) return null
  return current > now ? current : null
}

/** 一句能读的账：丢了多少、最近一次丢在什么时候。 */
/** 给渲染层看的快照：面板问一次就有数，不必去翻控制台。 */
export interface HalfDuplexView {
  playing: boolean
  untilMs: number
  total: number
  dropped: number
  line: string
}

export function halfDuplexLine(dropped: number, total: number): string {
  if (total <= 0) return '还没识别过'
  if (dropped <= 0) return `识别 ${total} 段，没有一段被半双工守卫丢掉`
  return `识别 ${total} 段，其中 ${dropped} 段是自己在说话时录到的，已丢弃`
}
