import type { VoiceOutTestResult } from '@shared/ipc'
import {
  VOICE_OUT_TEST_LINE,
  VOICE_OUT_VOICES,
  decideVoiceOutTest,
  normalizeVoiceOutEngine,
  resolveVoiceOutSynth,
  speakKeyVk
} from '@shared/voice-out'
import { speakPipeline } from './speech-pipeline'
import { SegmentPlayer } from './segment-player'
import { errorMessage } from '@shared/errors'
import { speechFailHint } from '@shared/speech-plan'
import { currentVoiceOutReadiness } from './voice-out-readiness'
import { loadSettings } from '../settings'
import { getOverlayManager } from '../../windows/overlay'


/** 顺序递增的请求号：窗口只认当前这一单，旧单的 READY/ENDED 一律忽略。 */
let nextRequestId = 1



/** 失败要有去处：浮层上给一行提示（2 秒后被捕获状态覆盖，本来就是一次性提醒）。 */
function showHint(text: string): void {
  try {
    getOverlayManager().setHint(text)
  } catch {
    // 浮层窗口可能还没起（探针/极早启动）；提示尽力而为，别让测试因此报错。
  }
}


/** 一键到底声出腿的结果：整句话到底进没进频道（音频播了但键没按上也算没进）。 */
export interface VoiceOutSpeakOutcome {
  spoken: boolean
  /** 首个失败说明（合成全败 / 键失败 / 播放失败）；成功为 null。 */
  error: string | null
}


/**
 * 「测试声出」的最小闭环：固定英文句 → 按设置里的声出引擎合成（Edge 英文占位 /
 * 离线本地 / GV 音色包）→ 所选输出设备（VB-Cable）→ 自动按住说话键播完 → 松开。
 * 合成失败不念也不按键；ENDED 没回来也不能把键按死。
 * 票 05 起同一条链还排语音对讲的声出腿（speakReply）。
 */
class VoiceOutService {
  private chain: Promise<unknown> = Promise.resolve({ ok: true, durationMs: null, hint: null })

  /** 排队进同一条链：连点测试、边测试边说话，两份音频、两组按键事件绝不能叠在一起。 */
  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const next = (): Promise<T> => job()
    this.chain = this.chain.then(next, next)
    return this.chain as Promise<T>
  }

  /** 串行：连点测试按钮必须排队，两份音频、两组按键事件绝不能叠在一起。 */
  test(): Promise<VoiceOutTestResult> {
    return this.enqueue(() => this.run())
  }

  /** 一键到底的声出腿：译文切段并行合成，按序播出，说话键全程按住。 */
  speakReply(text: string): Promise<VoiceOutSpeakOutcome> {
    return this.enqueue(() => this.runReply(text))
  }

  private async run(): Promise<VoiceOutTestResult> {
    const settings = loadSettings()
    const synth = resolveVoiceOutSynth(
      settings.ttsOutEngine,
      settings.ttsOutVoice,
      VOICE_OUT_TEST_LINE
    )
    // 合成收进管线：引擎、音色、语言、格式全由计划值决定，本腿只管「一段怎么播」。
    const got: Buffer[] = []
    await speakPipeline(
      {
        text: VOICE_OUT_TEST_LINE,
        engine: synth.engine,
        split: false,
        voice: synth.voice,
        rate: settings.ttsRate,
        pitch: settings.ttsPitch,
        lang: synth.lang,
        edgeVoices: VOICE_OUT_VOICES
      },
      (segment) => {
        if (segment.audio !== null) got.push(segment.audio)
      }
    )
    const audioOrNull: Buffer | null = got[0] ?? null
    const plan = decideVoiceOutTest(audioOrNull !== null, VOICE_OUT_TEST_LINE, synth)
    if (!plan.speak || audioOrNull === null) {
      // 知道缺哪一环就把原因念出来（与对讲页就绪行同源），不知道才退回总括句。
      const error =
        plan.skip === 'synth-failed'
          ? `${speechFailHint(synth.engine, currentVoiceOutReadiness()?.reason)}，这句不出声`
          : '测试句为空'
      console.log('VOICE_OUT_SKIP', JSON.stringify({ skip: plan.skip, engine: synth.engine }))
      showHint(error)
      return { ok: false, durationMs: null, hint: null, sinkLabel: '', error }
    }

    const audio = audioOrNull

    const requestId = nextRequestId
    nextRequestId += 1

    // 真正起播的那块设备由渲染层回报（onSpeak.sinkLabel）：面板测试结果要能说清「播到哪」。
    let playedSink: string | null = null
    const player = new SegmentPlayer({
      device: settings.ttsOutputDevice,
      monitorLocal: settings.ttsMonitorLocal,
      testMode: settings.voiceOutTestMode,
      keyVk: speakKeyVk(settings.ttsSpeakKey),
      speakMode: settings.ttsSpeakMode,
      onHint: showHint,
      onSpeak: ({ bytes, durationMs, sinkLabel, keyHeld, holdMs }) => {
        playedSink = sinkLabel || null
        console.log(
          'VOICE_OUT_SPEAK',
          JSON.stringify({
            requestId,
            engine: plan.engine,
            voice: plan.voice,
            bytes,
            durationMs,
            sink: sinkLabel || 'default',
            keyHeld,
            holdMs
          })
        )
      },
      onKeyError: (error) => console.log('VOICE_OUT_KEY_ERROR', JSON.stringify({ requestId, error }))
    })
    if (settings.voiceOutTestMode) {
      // 测试模式（voiceOutTestMode）：只放音频、不模拟按键——游戏没开也能试听，
      // F5 不会落到焦点窗口上（编辑器收到 F5 之类的误触发）。
      console.log('VOICE_OUT_TEST_MODE', JSON.stringify({ requestId, leg: 'test', keySuppressed: true }))
    }

    // 任何一条提前 return / 抛错的路径都必须松键——说话键卡死比测试失败严重得多。
    const outcome = await player.play(requestId, audio, plan.audioMime).finally(() => player.finish())
    const keyError = player.error ?? undefined

    if (outcome.kind === 'not-ready') {
      console.log('VOICE_OUT_NOT_READY', JSON.stringify({ requestId, error: outcome.error }))
      showHint(`声出失败：${outcome.error}`)
      return { ok: false, durationMs: null, hint: outcome.hint, sinkLabel: '', error: outcome.error }
    }
    if (outcome.kind === 'timeout') {
      console.log('VOICE_OUT_ENDED_TIMEOUT', JSON.stringify({ requestId }))
      return { ok: false, durationMs: outcome.durationMs, hint: outcome.hint, sinkLabel: playedSink ?? '', keyError, error: '播放结束事件超时（说话键已松开）' }
    }
    if (outcome.kind === 'failed') {
      return { ok: false, durationMs: outcome.durationMs, hint: outcome.hint, sinkLabel: playedSink ?? '', keyError, error: outcome.error ?? '播放失败' }
    }
    if (keyError) return { ok: false, durationMs: outcome.durationMs, hint: outcome.hint, sinkLabel: playedSink ?? '', keyError }
    return { ok: true, durationMs: outcome.durationMs, hint: outcome.hint, sinkLabel: playedSink ?? '' }
  }

  /** 错误绝不往外抛：链上还排着别的活，抛出去会污染后面每一单。 */
  private async runReply(text: string): Promise<VoiceOutSpeakOutcome> {
    try {
      return await this.runReplyInner(text)
    } catch (err) {
      const error = errorMessage(err)
      console.log('VOICE_REPLY_ERROR', JSON.stringify({ error }))
      return { spoken: false, error }
    }
  }

  private async runReplyInner(text: string): Promise<VoiceOutSpeakOutcome> {
    const settings = loadSettings()
    // 引擎/封装/嗓逐段按设置解析（与测试腿同一个 resolveVoiceOutSynth）：音色传面板「声出音色」
    // （ttsOutVoice）——测试声出验的就是对讲要用的这把嗓；GV 本就不选嗓（音色由参考音频决定），
    // 解析层自己打回各引擎默认。
    const plan = resolveVoiceOutSynth(settings.ttsOutEngine, settings.ttsOutVoice, text)
    const player = new SegmentPlayer({
      device: settings.ttsOutputDevice,
      monitorLocal: settings.ttsMonitorLocal,
      testMode: settings.voiceOutTestMode,
      keyVk: speakKeyVk(settings.ttsSpeakKey),
      speakMode: settings.ttsSpeakMode,
      onHint: showHint,
      onKeyError: (error, requestId) => console.log('VOICE_REPLY_KEY_ERROR', JSON.stringify({ requestId, error }))
    })

    let synthOkAny = false
    let audioPlayed = false
    let segmentCount = 0
    try {
      // 合成→按序投递收进 speech-pipeline：切段并行合成（GV 走它自带的懒队列），这里只管「一段怎么播」——
      // 等窗口就绪、按住说话键、起播等结束；单段翻车跳过这段继续。
      await speakPipeline(
        {
          text,
          engine: plan.engine,
          split: true,
          segmentChars: settings.ttsSpeakSegmentChars,
          voice: plan.voice,
          edgeVoices: VOICE_OUT_VOICES,
          rate: settings.ttsRate,
          pitch: settings.ttsPitch,
          resolveSegment: (segment) => {
            const synth = resolveVoiceOutSynth(settings.ttsOutEngine, settings.ttsOutVoice, segment)
            return { voice: synth.voice, lang: synth.lang }
          }
        },
        async (segment) => {
          segmentCount += 1
          if (segment.audio === null) return
          synthOkAny = true
          const requestId = nextRequestId
          nextRequestId += 1
          const outcome = await player.play(requestId, segment.audio, segment.audioMime ?? 'audio/mpeg')
          if (outcome.kind === 'not-ready') {
            // 单段翻车不毁整句：跳过这段继续下一段，日志里数得清丢了几段。
            console.log('VOICE_REPLY_SEGMENT_SKIP', JSON.stringify({ requestId, index: segment.index, error: outcome.error }))
            if (outcome.hint) showHint(outcome.hint)
            return
          }
          if (outcome.kind === 'timeout') {
            console.log('VOICE_REPLY_SEGMENT_TIMEOUT', JSON.stringify({ requestId, index: segment.index }))
            return
          }
          if (outcome.kind === 'failed') {
            console.log('VOICE_REPLY_SEGMENT_FAIL', JSON.stringify({ requestId, index: segment.index, error: outcome.error }))
            return
          }
          audioPlayed = true
          console.log('VOICE_REPLY_SEGMENT_OK', JSON.stringify({ requestId, index: segment.index, durationMs: outcome.durationMs }))
        }
      )
    } finally {
      // 尾巴：最后一截音频收进频道再松键；任何提前 return / 抛错的路径都必须松键。
      await player.finish()
    }

    if (!synthOkAny) {
      // 全部段合成失败：不播、不按键，引擎跟设置走——别把「断网」误报给离线/GV 用户（与测试腿同一份提示表）。
      const engine = normalizeVoiceOutEngine(settings.ttsOutEngine)
      const error = `${speechFailHint(engine, currentVoiceOutReadiness()?.reason)}，这句不出声`
      console.log('VOICE_REPLY_SKIP', JSON.stringify({ skip: 'synth-failed', engine, segments: segmentCount }))
      showHint(error)
      return { spoken: false, error }
    }
    if (!audioPlayed) return { spoken: false, error: '声出播放失败' }
    if (player.error) {
      // 音频播出去了（本地能听见），但频道没开——队友没听到，按失败算并说明原因。
      return { spoken: false, error: player.error }
    }
    return { spoken: true, error: null }
  }
}

let service: VoiceOutService | null = null

export function getVoiceOutService(): VoiceOutService {
  if (!service) service = new VoiceOutService()
  return service
}
