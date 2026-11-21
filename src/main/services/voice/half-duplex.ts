/**
 * #129：半双工守卫的记账面。
 *
 * 播放侧（`voice-out.ts` 的两条腿）在真正起播时调用 `notePlayback(at, durationMs)`；
 * 识别侧（`transcribeForVoice`）进门先问 `judgeCaptureAt(now)`。两处都只碰这里，
 * 所以「谁在什么时候闭嘴」只有一份答案。
 *
 * 不开同传也守着：公告腿（`speech.ts`）同样把声音放出来，那时的回声一样不该被识别。
 * 这条规则不依赖任何设置，判断只看「我们的播放窗口是否还开着」。
 */
import { appendVoiceChainLine } from './chain-log'
import {
  expireWindow,
  extendPlaybackWindow,
  halfDuplexLine,
  judgeHalfDuplex,
  normalizePlaybackLeg,
  type HalfDuplexSnapshot,
  type PlaybackLeg
} from '@shared/half-duplex'

let playingUntil: number | null = null
// 最后一条在放的腿：丢弃时要写进日志，才分得清「公告在念」与「同传回放在响」。
let playingLeg: PlaybackLeg = 'unknown'
let total = 0
let dropped = 0
let lastDropAt = 0

/** 一段音频真的开始播了：把窗口延长到它播完（再加尾巴），并记住是哪条腿。 */
export function notePlayback(at: number, durationMs: number, leg: PlaybackLeg | string = 'unknown'): void {
  const named = normalizePlaybackLeg(leg)
  // #163：时长没量到（渲染层没报 size/duration）时窗口根本不会开，过去一行痕迹都没有 ——
  // 现场于是分不清「没丢」与「没记账」。这里留一行痕迹，但**不计入** total/dropped：
  // 记账不是判定，把它算进丢掉的段数会让面板数字说谎。
  const measured = Number.isFinite(durationMs) && durationMs > 0
  if (!measured) {
    appendVoiceChainLine({
      at: new Date(at).toISOString(),
      kind: 'half-duplex-skip',
      stage: named,
      // 0 与 NaN 都记 null：两种都表示「没量到」，写成 0 会被读成「量到了、长度为零」。
      durationMs: measured ? durationMs : null,
      note: '播放端没量到时长：这道守卫这次没有窗口，等于没在守'
    })
    return
  }
  playingUntil = extendPlaybackWindow(expireWindow(playingUntil, at), at, durationMs)
  playingLeg = named
}

/**
 * 这一段提前结束了（onended / onerror / 播到一半被新一段抢掉）：立刻关窗，
 * 不靠时长硬等到点——残留窗口会把下一句正常说话也一起丢掉。
 * 只关「最后报上来的那条腿」自己的窗口；别的腿还在放时不误关。
 */
export function endPlayback(leg: PlaybackLeg | string = 'unknown'): void {
  const named = normalizePlaybackLeg(leg)
  if (named !== 'unknown' && playingLeg !== 'unknown' && named !== playingLeg) return
  // 这里必须是「强行清空」而不是 expireWindow：窗口还没到期，expireWindow 会原样留着。
  playingUntil = null
  playingLeg = 'unknown'
}

/** 这段录音该不该识别；调用即计入「识别尝试」总数。 */
export function judgeCaptureAt(now: number): {
  drop: boolean
  reason: 'playback' | null
  error: string | null
  /** 窗口还剩多少毫秒：写进日志，才知道这一丢代价多大。 */
  penaltyMs: number
  /** 当时是哪条腿在放。 */
  leg: PlaybackLeg
} {
  total += 1
  playingUntil = expireWindow(playingUntil, now)
  const verdict = judgeHalfDuplex({ playingUntil, now })
  if (!verdict.drop) return { drop: false, reason: null, error: null, penaltyMs: 0, leg: 'unknown' }
  dropped += 1
  lastDropAt = now
  return {
    drop: true,
    reason: verdict.reason,
    error: '上一句还在播，这段录音是它自己的回声，已丢弃',
    penaltyMs: verdict.untilMs,
    leg: playingLeg
  }
}

export type { HalfDuplexSnapshot }

export function halfDuplexSnapshot(now: number = Date.now()): HalfDuplexSnapshot {
  playingUntil = expireWindow(playingUntil, now)
  const verdict = judgeHalfDuplex({ playingUntil, now })
  return {
    playing: verdict.drop,
    untilMs: verdict.untilMs,
    total,
    dropped,
    leg: verdict.drop ? playingLeg : 'unknown',
    penaltyMs: verdict.drop ? verdict.untilMs : 0,
    line: halfDuplexLine(dropped, total)
  }
}

/** 探针用：清空窗口与计数，别把上一次的结果带进下一条断言。 */
export function resetHalfDuplexForProbe(): void {
  playingUntil = null
  playingLeg = 'unknown'
  total = 0
  dropped = 0
  lastDropAt = 0
}

/** 最近一次丢弃的时刻（0 = 从没丢过）；日志与探针判断「刚刚才丢的」。 */
export function lastHalfDuplexDropAt(): number {
  return lastDropAt
}
