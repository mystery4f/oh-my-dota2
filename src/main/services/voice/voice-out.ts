import {
  type VoiceOutEndedReport,
  type VoiceOutReadyReport,
  type VoiceOutTestResult
} from '@shared/ipc'
import {
  MIN_SPEAK_MS,
  PTT_MARGIN_MS,
  VOICE_OUT_TEST_LINE,
  VOICE_OUT_VOICES,
  decideVoiceOutTest,
  normalizeVoiceOutEngine,
  pttWatchdogMs,
  pttWindow,
  resolveVoiceOutSynth,
  speakKeyVk,
} from '@shared/voice-out'
import { speakPipeline } from './speech-pipeline'
import { speechFailHint } from '@shared/speech-plan'
import { loadSettings } from '../settings'
import { getPttKeySender } from '../input/ptt-key'
import { getVoiceOutWindow } from '../../windows/voice-out'
import { getOverlayManager } from '../../windows/overlay'

/** 窗口侧枚举设备 + setSinkId + 解码读时长的总预算：必须盖过最坏路径——页面加载 8 s（PAGE_LOAD_TIMEOUT_MS）+ 页面内读音频时长 8 s = 16 s。 */
const READY_TIMEOUT_MS = 17_000

/** 顺序递增的请求号：窗口只认当前这一单，旧单的 READY/ENDED 一律忽略。 */
let nextRequestId = 1


function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/** 失败要有去处：浮层上给一行提示（2 秒后被捕获状态覆盖，本来就是一次性提醒）。 */
function showHint(text: string): void {
  try {
    getOverlayManager().setHint(text)
  } catch {
    // 浮层窗口可能还没起（探针/极早启动）；提示尽力而为，别让测试因此报错。
  }
}

function waitReady(requestId: number, timeoutMs: number): Promise<VoiceOutReadyReport | null> {
  const window = getVoiceOutWindow()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      offReady()
      offEnded()
      resolve(null)
    }, timeoutMs)
    const offReady = window.onReady((report) => {
      if (report.requestId !== requestId) return
      clearTimeout(timer)
      offEnded()
      resolve(report)
    })
    const offEnded = window.onEnded((report) => {
      // 页面在 READY 之后立刻翻车（解码/播放被拒）：当成 ready=false 处理，别傻等。
      if (report.requestId !== requestId) return
      clearTimeout(timer)
      offReady()
      resolve({ requestId, ok: false, durationMs: report.durationMs, sinkId: '', sinkLabel: '', fallback: false, hint: null, error: report.error })
    })
  })
}

function waitEnded(requestId: number, timeoutMs: number): Promise<VoiceOutEndedReport | null> {
  const window = getVoiceOutWindow()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      offEnded()
      resolve(null)
    }, timeoutMs)
    const offEnded = window.onEnded((report) => {
      if (report.requestId !== requestId) return
      clearTimeout(timer)
      resolve(report)
    })
  })
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
      const error = plan.skip === 'synth-failed' ? `${speechFailHint(synth.engine)}，这句不出声` : '测试句为空'
      console.log('VOICE_OUT_SKIP', JSON.stringify({ skip: plan.skip, engine: synth.engine }))
      showHint(error)
      return { ok: false, durationMs: null, hint: null, error }
    }

    const audio = audioOrNull

    const requestId = nextRequestId
    nextRequestId += 1
    const window = getVoiceOutWindow()
    const readyPromise = waitReady(requestId, READY_TIMEOUT_MS)
    await window.play({
      requestId,
      audioBase64: audio.toString('base64'),
      audioMime: plan.audioMime,
      requestedDevice: settings.ttsOutputDevice
    })

    const ready = await readyPromise
    if (!ready || !ready.ok) {
      const error = ready?.error ?? '声出窗口没有就绪（超时）'
      console.log('VOICE_OUT_NOT_READY', JSON.stringify({ requestId, error }))
      showHint(`声出失败：${error}`)
      return { ok: false, durationMs: null, hint: ready?.hint ?? null, error }
    }

    const durationMs = ready.durationMs
    const hold = pttWindow(durationMs ?? MIN_SPEAK_MS)
    if (ready.fallback && ready.hint) showHint(ready.hint)

    // 声出已经成功（音频在手、窗口就绪），从这一刻起说话键才允许动。
    // 测试模式（voiceOutTestMode）：只放音频、不模拟按键——游戏没开也能试听，
    // F5 不会落到焦点窗口上（编辑器收到 F5 之类的误触发）。
    const vk = speakKeyVk(settings.ttsSpeakKey)
    let keyError: string | undefined
    let keyHeld = false
    if (settings.voiceOutTestMode) {
      console.log('VOICE_OUT_TEST_MODE', JSON.stringify({ requestId, leg: 'test', keySuppressed: true }))
    } else if (vk === null) {
      keyError = '说话键无法识别（检查设置里的说话键）'
    } else {
      const down = await getPttKeySender().down(vk)
      if (down.ok) keyHeld = true
      else keyError = down.error
    }
    if (keyError) {
      console.log('VOICE_OUT_KEY_ERROR', JSON.stringify({ requestId, error: keyError }))
      // 键没按上也要把话播完：默认输出时用户至少能听见，频道没开是另一回事。
    }

    console.log(
      'VOICE_OUT_SPEAK',
      JSON.stringify({
        requestId,
        engine: plan.engine,
        voice: plan.voice,
        bytes: audio.length,
        durationMs,
        sink: ready.sinkLabel || 'default',
        keyHeld,
        holdMs: hold.holdMs
      })
    )

    const releaseKey = async (): Promise<void> => {
      if (!keyHeld) return
      keyHeld = false
      if (vk === null) return
      const up = await getPttKeySender().up(vk)
      if (!up.ok && !keyError) keyError = up.error
    }

    try {
      await delay(hold.leadMs)
      window.start(requestId)
      const ended = await waitEnded(requestId, pttWatchdogMs(hold))
      if (!ended) {
        console.log('VOICE_OUT_ENDED_TIMEOUT', JSON.stringify({ requestId }))
        return { ok: false, durationMs, hint: ready.hint, keyError, error: '播放结束事件超时（说话键已松开）' }
      }
      if (!ended.ok) {
        return { ok: false, durationMs: ended.durationMs ?? durationMs, hint: ready.hint, keyError, error: ended.error ?? '播放失败' }
      }
      // 正常结束：再按住 releaseMs 的尾巴，保证游戏把最后一截音频收进频道。
      await delay(hold.releaseMs)
      await releaseKey()
      if (keyError) {
        return { ok: false, durationMs: ended.durationMs ?? durationMs, hint: ready.hint, keyError }
      }
      return { ok: true, durationMs: ended.durationMs ?? durationMs, hint: ready.hint }
    } finally {
      // 任何一条提前 return / 抛错的路径都必须松键——说话键卡死比测试失败严重得多。
      await releaseKey()
    }
  }

  /** 错误绝不往外抛：链上还排着别的活，抛出去会污染后面每一单。 */
  private async runReply(text: string): Promise<VoiceOutSpeakOutcome> {
    try {
      return await this.runReplyInner(text)
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err)
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

    const window = getVoiceOutWindow()
    const vk = speakKeyVk(settings.ttsSpeakKey)
    let keyError: string | null = null
    let keyHeld = false
    const releaseKey = async (): Promise<void> => {
      if (!keyHeld) return
      keyHeld = false
      if (vk === null) return
      const up = await getPttKeySender().up(vk)
      if (!up.ok && !keyError) keyError = up.error ?? null
    }

    let startedAny = false
    let audioPlayed = false
    let synthOkAny = false
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
          const readyPromise = waitReady(requestId, READY_TIMEOUT_MS)
          await window.play({
            requestId,
            audioBase64: segment.audio.toString('base64'),
            audioMime: segment.audioMime ?? 'audio/mpeg',
            requestedDevice: settings.ttsOutputDevice
          })
          const ready = await readyPromise
          if (!ready || !ready.ok) {
            // 单段翻车不毁整句：跳过这段继续下一段，日志里数得清丢了几段。
            const reason = ready?.error ?? '声出窗口没有就绪（超时）'
            console.log('VOICE_REPLY_SEGMENT_SKIP', JSON.stringify({ requestId, index: segment.index, error: reason }))
            if (ready?.hint) showHint(ready.hint)
            return
          }
          if (ready.fallback && ready.hint) showHint(ready.hint)

          // 说话键从第一段就绪起按住，整句话期间绝不松——中途松键频道会露缝。
          // 测试模式下整段按键逻辑跳过（keyHeld 恒 false，finally 的松键自然空转）。
          if (!settings.voiceOutTestMode && !keyHeld && !keyError) {
            if (vk === null) {
              keyError = '说话键无法识别（检查设置里的说话键）'
            } else {
              const down = await getPttKeySender().down(vk)
              if (down.ok) keyHeld = true
              else keyError = down.error ?? null
            }
            if (keyError) console.log('VOICE_REPLY_KEY_ERROR', JSON.stringify({ requestId, index: segment.index, error: keyError }))
          }

          const hold = pttWindow(ready.durationMs ?? MIN_SPEAK_MS)
          // 头部余量只等一次（第一次起播前）；后续段接着上一段的尾巴连续播。
          if (!startedAny) await delay(hold.leadMs)
          startedAny = true
          window.start(requestId)
          const ended = await waitEnded(requestId, pttWatchdogMs(hold))
          if (!ended) {
            console.log('VOICE_REPLY_SEGMENT_TIMEOUT', JSON.stringify({ requestId, index: segment.index }))
            return
          }
          if (!ended.ok) {
            console.log('VOICE_REPLY_SEGMENT_FAIL', JSON.stringify({ requestId, index: segment.index, error: ended.error }))
            return
          }
          audioPlayed = true
          console.log('VOICE_REPLY_SEGMENT_OK', JSON.stringify({ requestId, index: segment.index, durationMs: ended.durationMs ?? ready.durationMs }))
        }
      )
    } finally {
      if (keyHeld) await delay(PTT_MARGIN_MS) // 尾巴：最后一截音频收进频道再松键。
      // 任何一条提前 return / 抛错的路径都必须松键——说话键卡死比这句没播出严重得多。
      await releaseKey()
    }

    if (!synthOkAny) {
      // 全部段合成失败：不播、不按键，引擎跟设置走——别把「断网」误报给离线/GV 用户（与测试腿同一份提示表）。
      const engine = normalizeVoiceOutEngine(settings.ttsOutEngine)
      const error = `${speechFailHint(engine)}，这句不出声`
      console.log('VOICE_REPLY_SKIP', JSON.stringify({ skip: 'synth-failed', engine, segments: segmentCount }))
      showHint(error)
      return { spoken: false, error }
    }
    if (!audioPlayed) return { spoken: false, error: '声出播放失败' }
    if (keyError) {
      // 音频播出去了（本地能听见），但频道没开——队友没听到，按失败算并说明原因。
      return { spoken: false, error: keyError }
    }
    return { spoken: true, error: null }
  }
}

let service: VoiceOutService | null = null

export function getVoiceOutService(): VoiceOutService {
  if (!service) service = new VoiceOutService()
  return service
}
