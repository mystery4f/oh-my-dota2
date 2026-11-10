import { join } from 'node:path'
import { app } from 'electron'
import type { VoiceStage, VoiceStageMark, VoiceStageProgress } from '@shared/voice-stage'
import type { VoiceChainTiming } from '@shared/voice-timing'
import { appendCappedJsonl } from '../logs/jsonl'

/**
 * 对讲计时（voice-reply-latency）：谁在等、等在哪一段。
 *
 * 这条链严格串行（识别 → 翻译 → 首段合成 → 起播 → 播完），所以一份计时跟着链走：
 * 识别那一段由 transcribeForVoice 记账（noteAsrRun），voiceReply 开头把它领走（takeAsrRun），
 * 后面的段各自在自己的执行点打一下 note。只认第一次，重复打点不会把数字改小。
 *
 * 识别记录 60 秒内有效：对讲一次一句，中间没有别的识别能插进来；超时说明这句不是对讲来的
 * （例如识别训练那边也在转写），宁可缺段也不张冠李戴。
 */
const ASR_TTL_MS = 60_000
let pendingAsr: { startedAt: number; ms: number; mic: string; measuredAt: number } | null = null

export function noteAsrRun(startedAt: number, ms: number, mic = ''): void {
  pendingAsr = { startedAt, ms, mic, measuredAt: Date.now() }
}

/** 领走最近一次识别；`now` 只为探针可测（TTL 判定），正常调用不用传。 */
export function takeAsrRun(now = Date.now()): { startedAt: number; ms: number; mic: string } | null {
  const hit = pendingAsr
  pendingAsr = null
  if (!hit || now - hit.measuredAt > ASR_TTL_MS) return null
  return { startedAt: hit.startedAt, ms: hit.ms, mic: hit.mic }
}

/** 起播那 2 秒的三段拆账（窗口准备 / 按说话键 / 首段余量），只进日志，不进计时模型。 */
export interface ChainPrepMs {
  readyMs: number
  keyMs: number
  leadMs: number
}

/** 每完成一段就打一次：对讲行拿它画留痕，谁都不许自己另算一套时间。 */
export interface ChainStageHooks {
  onStage?: (progress: VoiceStageProgress) => void
}
export class ChainTimer {
  private readonly replyStartedAt = Date.now()
  private translatedAt: number | null = null
  private firstAudioAt: number | null = null
  private playStartedAt: number | null = null
  private speakEndedAt: number | null = null
  /** 已完成各段的耗时（按链上的顺序），预算是给对讲行的留痕用的。 */
  private readonly marks: VoiceStageMark[] = []
  private prepMs: ChainPrepMs | null = null

  /** 这句是从哪台输入设备录的（label|id 前 8 位）：断声、串音只有它能解释。 */
  readonly mic: string

  constructor(
    private readonly asr: { startedAt: number; ms: number; mic: string } | null,
    private readonly hooks?: ChainStageHooks
  ) {
    this.mic = asr?.mic ?? ''
  }

  /** 完成一段：先记下真实耗时再回调——回调里拿到的一定是已经更新的快照。 */
  private complete(stage: VoiceStageMark['stage'], ms: number, current: VoiceStage): void {
    this.marks.push({ stage, ms })
    this.hooks?.onStage?.({ marks: [...this.marks], current })
  }

  /** 译文到手：翻译段的终点，也是首音段的起点。 */
  noteTranslated(): void {
    if (this.translatedAt !== null) return
    this.translatedAt = Date.now()
    this.complete('translate', this.translatedAt - this.replyStartedAt, 'synth')
  }

  /** 第一段音频到手（合成段里第一个非空音频）。 */
  noteFirstAudio(): void {
    if (this.firstAudioAt !== null) return
    this.firstAudioAt = Date.now()
    if (this.translatedAt !== null) this.complete('synth', this.firstAudioAt - this.translatedAt, 'playStart')
  }

  /** 真正出声（说话键已按下、播放窗口开始播）。 */
  notePlayStart(): void {
    if (this.playStartedAt !== null) return
    this.playStartedAt = Date.now()
    if (this.firstAudioAt !== null) this.complete('playStart', this.playStartedAt - this.firstAudioAt, 'play')
  }

  /** 整句播完（所有段送完，松键之前）。 */
  noteSpeakEnd(): void {
    if (this.speakEndedAt !== null) return
    this.speakEndedAt = Date.now()
    if (this.playStartedAt !== null) this.complete('play', this.speakEndedAt - this.playStartedAt, 'done')
  }

  /** 起播那 2 秒的拆账：只记不判，落进 logs/voice-chain.jsonl 后才能回答「为什么是 2 秒」。 */
  notePrep(prep: ChainPrepMs): void {
    this.prepMs ??= prep
  }

  prep(): ChainPrepMs | null {
    return this.prepMs
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
  /** 实际打开的那台输入设备；识别不是从对讲来的、或没量到时为空串。 */
  mic: string
}

/**
 * 一句一行的真机证据：控制台一行给开发，logs/voice-chain.jsonl 一份给「慢在哪一段」的回填。
 * 返回同一份计时，直接塞进 VoiceReplyResult 交给浮层与面板。
 */
export function reportChainTiming(timer: ChainTimer, meta: VoiceChainMeta): VoiceChainTiming {
  const timing = timer.timing()
  const prep = timer.prep()
  const record = { at: new Date().toISOString(), ...meta, ...timing, ...(prep === null ? {} : { prep }) }
  console.log('VOICE_CHAIN_TIMING', JSON.stringify(record))
  appendCappedJsonl(join(app.getPath('userData'), 'logs', 'voice-chain.jsonl'), record)
  return timing
}
