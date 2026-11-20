import { join } from 'node:path'
import { IPC, type SpeakPayload } from '@shared/ipc'
import { appendCappedJsonl } from '../logs/jsonl'
import { logsDir } from '../logs/base-dir'
import { loadSettings } from '../settings'
import { broadcastToWindows } from '../../windows/broadcast'
import { requestFromPlan, speakPipeline } from './speech-pipeline'
import {
  DEFAULT_ANNOUNCE_TRIGGERS,
  initialAnnounceState,
  stepAnnounces,
  type DotaAnnounceEvent,
  type DotaAnnounceFrame,
  type DotaAnnounceState,
  type DotaAnnounceTriggers
} from '@shared/dota-announce'

/**
 * 对局播报腿（issue #123）：GSI 帧进来 → 纯状态机判该报什么 → 走朗读同款管线念出来。
 *
 * 与朗读/声出的分工：朗读念聊天，声出念给队友听，这里念的是**游戏自己的状态**
 * （智慧符、肉山窗口、堆野/拉野窗口）。念的引擎、嗓、语速、音高全部沿用朗读设置，
 * 不再开一套；总闸 `announceTotal` 关着时连纯状态机都不进，管线一次都不碰。
 */
const ANNOUNCE_LOG_MAX_BYTES = 256_000

/** 总闸：默认关。关着就是「没这个功能」，而不是「念了但静音」。 */
export function totalAnnouncesOn(settings: { announceTotal?: boolean }): boolean {
  return settings.announceTotal === true
}

/** 单事件闸：帧里没写的按缺省（全开），总闸关着时单事件怎么设都不出声。 */
export function perAnnouncesOn(settings: {
  announceTriggers?: Partial<DotaAnnounceTriggers>
}): DotaAnnounceTriggers {
  return { ...DEFAULT_ANNOUNCE_TRIGGERS, ...(settings.announceTriggers ?? {}) }
}

export interface FeedAnnounceOptions {
  total: boolean
  per: DotaAnnounceTriggers
  speak: (event: DotaAnnounceEvent) => void
  log: (event: DotaAnnounceEvent, now: number) => void
}

/**
 * 一帧交给播报腿。总闸关 → 直接返回空数组，`stepAnnounces` 都不进（管线零调用）。
 * 单事件闸关 → 这一条不出声也不落日志：切掉的触发在日志里也不该出现，
 * 否则「日志里有、耳朵没听到」会被当成 bug 查。
 */
export function feedAnnouncement(
  frame: DotaAnnounceFrame,
  state: DotaAnnounceState,
  options: FeedAnnounceOptions,
  now: number = Date.now()
): DotaAnnounceEvent[] {
  if (!options.total) return []
  const events = stepAnnounces(state, frame)
  for (const event of events) {
    if (options.per[event.id] !== true) continue
    options.speak(event)
    options.log(event, now)
  }
  return events
}

/** 真机念一条：朗读同款引擎与嗓；system 引擎交给浮层 speechSynthesis（payload 不带音频）。 */
export function speakAnnouncement(event: DotaAnnounceEvent): void {
  const settings = loadSettings()
  void speakPipeline(
    requestFromPlan(
      event.text,
      {
        engine: settings.ttsEngine,
        voice: settings.ttsVoice,
        rate: settings.ttsRate,
        pitch: settings.ttsPitch
      },
      { lane: 'announce', split: true, segmentChars: settings.ttsSpeakSegmentChars ?? 30 }
    ),
    (segment) => {
      const payload: SpeakPayload = {
        ts: Date.now(),
        text: segment.text,
        engine: settings.ttsEngine,
        lang: /[\u4e00-\u9fff]/.test(segment.text) ? 'zh' : 'en',
        rate: settings.ttsRate,
        pitch: settings.ttsPitch,
        voice: settings.ttsVoice,
        ...(segment.audio && segment.audioMime
          ? { audio: segment.audio.toString('base64'), audioMime: segment.audioMime }
          : {})
      }
      broadcastToWindows(IPC.VOICE_SPEAK, payload)
    }
  ).catch(() => undefined)
}

/** 落一行：触发 id + 造成它的帧时间都要有，排查时不用猜是第几分钟报的。 */
export function logAnnouncement(event: DotaAnnounceEvent, now: number): void {
  appendCappedJsonl(
    join(logsDir(), 'announce.jsonl'),
    { at: new Date(now).toISOString(), id: event.id, gameTime: event.gameTime, text: event.text },
    ANNOUNCE_LOG_MAX_BYTES
  )
}

/** 主进程的常驻状态：跟着 GSI 帧跑，换局由纯状态机自己清记忆。 */
const liveState: DotaAnnounceState = initialAnnounceState()

/**
 * GSI 每帧调一次（`handleGsiPayload` 里）。没开闸时是个空调用，
 * 但也不能什么都不做——总闸开关要能在面板上随时打开，状态机得一直跟着帧走，
 * 否则打开那一刻会把整局错过的窗口一口气补报出来。
 */
export function feedLiveAnnouncement(
  frame: DotaAnnounceFrame,
  options?: Partial<FeedAnnounceOptions>
): DotaAnnounceEvent[] {
  const settings = loadSettings()
  return feedAnnouncement(frame, liveState, {
    total: options?.total ?? totalAnnouncesOn(settings),
    per: options?.per ?? perAnnouncesOn(settings),
    speak: options?.speak ?? speakAnnouncement,
    log: options?.log ?? logAnnouncement
  })
}

/** 探针/测试把常驻状态清回起点（换局以外的地方不要用）。 */
export function resetLiveAnnouncementState(): void {
  Object.assign(liveState, initialAnnounceState())
}

/** 从一帧 payload 抽出播报需要的三个事实；缺哪个就留 null，不猜默认值。 */
export function announceFrameOf(payload: {
  map?: { game_time?: number; matchid?: string }
  roshan?: { state?: string; death_time?: number; respawn_time?: number } | null
}): DotaAnnounceFrame {
  const gameTime = typeof payload.map?.game_time === 'number' ? payload.map.game_time : null
  return {
    gameTime,
    matchId: payload.map?.matchid ?? null,
    roshan: payload.roshan ?? null
  }
}