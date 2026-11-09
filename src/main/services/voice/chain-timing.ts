import { join } from 'node:path'
import { app } from 'electron'
import type { VoiceChainTiming } from '@shared/voice-timing'
import { appendCappedJsonl } from '../logs/jsonl'

/**
 * 对讲计时（voice-reply-latency）：谁在等、等在哪一段。
 *
 * 这条链严格串行（识别 → 翻译 → 首段合成 → 起播 → 播完），所以一份计时跟着链走：
 * 识别那一段由 transcribeAudio 记账（noteAsrRun），voiceReply 开头把它领走（takeAsrRun），
 * 后面的段各自在自己的执行点打一下 note。只认第一次，重复打点不会把数字改小。
 *
 * 识别记录 60 秒内有效：对讲一次一句，中间没有别的识别能插进来；超时说明这句不是对讲来的
 * （例如识别训练那边也在转写），宁可缺段也不张冠李戴。
 */
const ASR_TTL_MS = 60_000
let pendingAsr: { startedAt: number; ms: number; measuredAt: number } | null = null

export function noteAsrRun(startedAt: number, ms: number): void {
  pendingAsr = { startedAt, ms, measuredAt: Date.now() }
}

/** 领走最近一次识别；`now` 只为探针可测（TTL 判定），正常调用不用传。 */
export function takeAsrRun(now = Date.now()): { startedAt: number; ms: number } | null {
  const hit = pendingAsr
  pendingAsr = null
  if (!hit || now - hit.measuredAt > ASR_TTL_MS) return null
  return { startedAt: hit.startedAt, ms: hit.ms }
}

export class ChainTimer {
  private readonly replyStartedAt = Date.now()
  private translatedAt: number | null = null
  private firstAudioAt: number | null = null
  private playStartedAt: number | null = null
  private speakEndedAt: number | null = null

  constructor(private readonly asr: { startedAt: number; ms: number } | null) {}

  /** 译文到手：翻译段的终点，也是首音段的起点。 */
  noteTranslated(): void {
    this.translatedAt ??= Date.now()
  }

  /** 第一段音频到手（合成段里第一个非空音频）。 */
  noteFirstAudio(): void {
    this.firstAudioAt ??= Date.now()
  }

  /** 真正出声（说话键已按下、播放窗口开始播）。 */
  notePlayStart(): void {
    this.playStartedAt ??= Date.now()
  }

  /** 整句播完（所有段送完，松键之前）。 */
  noteSpeakEnd(): void {
    this.speakEndedAt ??= Date.now()
  }

  timing(): VoiceChainTiming {
    const base = this.asr?.startedAt ?? (this.replyStartedAt as number)
    return {
      asrMs: this.asr?.ms ?? null,
      translateMs: this.translatedAt === null ? null : this.translatedAt - this.replyStartedAt,
      firstAudioMs:
        this.firstAudioAt === null || this.translatedAt === null ? null : this.firstAudioAt - this.translatedAt,
      playStartMs:
        this.playStartedAt === null || this.firstAudioAt === null ? null : this.playStartedAt - this.firstAudioAt,
      speakMs: this.speakEndedAt === null || this.playStartedAt === null ? null : this.speakEndedAt - this.playStartedAt,
      totalMs: this.playStartedAt === null ? null : this.playStartedAt - base
    }
  }
}

export interface VoiceChainMeta {
  /** 这句到底进没进频道（`spoken`）：失败的那次同样值得记，它给出的是「崩在哪一段」。 */
  spoken: boolean
  stage: string | null
  engine: string | null
  chars: number
  segments: number
}

/**
 * 一句一行的真机证据：控制台一行给开发，logs/voice-chain.jsonl 一份给「慢在哪一段」的回填。
 * 返回同一份计时，直接塞进 VoiceReplyResult 交给浮层与面板。
 */
export function reportChainTiming(timer: ChainTimer, meta: VoiceChainMeta): VoiceChainTiming {
  const timing = timer.timing()
  const record = { at: new Date().toISOString(), ...meta, ...timing }
  console.log('VOICE_CHAIN_TIMING', JSON.stringify(record))
  appendCappedJsonl(join(app.getPath('userData'), 'logs', 'voice-chain.jsonl'), record)
  return timing
}
