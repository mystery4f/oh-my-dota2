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
import { expireWindow, extendPlaybackWindow, halfDuplexLine, judgeHalfDuplex } from '@shared/half-duplex'

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

let playingUntil: number | null = null
let total = 0
let dropped = 0
let lastDropAt = 0

/** 一段音频真的开始播了：把窗口延长到它播完（再加尾巴）。 */
export function notePlayback(at: number, durationMs: number): void {
  playingUntil = extendPlaybackWindow(expireWindow(playingUntil, at), at, durationMs)
}

/** 这段录音该不该识别；调用即计入「识别尝试」总数。 */
export function judgeCaptureAt(now: number): { drop: boolean; reason: 'playback' | null; error: string | null } {
  total += 1
  playingUntil = expireWindow(playingUntil, now)
  const verdict = judgeHalfDuplex({ playingUntil, now })
  if (!verdict.drop) return { drop: false, reason: null, error: null }
  dropped += 1
  lastDropAt = now
  return { drop: true, reason: verdict.reason, error: '上一句还在播，这段录音是它自己的回声，已丢弃' }
}

export function halfDuplexSnapshot(now: number = Date.now()): HalfDuplexSnapshot {
  playingUntil = expireWindow(playingUntil, now)
  const verdict = judgeHalfDuplex({ playingUntil, now })
  return {
    playing: verdict.drop,
    untilMs: verdict.untilMs,
    total,
    dropped,
    line: halfDuplexLine(dropped, total)
  }
}

/** 探针用：清空窗口与计数，别把上一次的结果带进下一条断言。 */
export function resetHalfDuplexForProbe(): void {
  playingUntil = null
  total = 0
  dropped = 0
  lastDropAt = 0
}

/** 最近一次丢弃的时刻（0 = 从没丢过）；日志与探针判断「刚刚才丢的」。 */
export function lastHalfDuplexDropAt(): number {
  return lastDropAt
}
