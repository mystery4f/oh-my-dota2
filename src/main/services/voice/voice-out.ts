import {
  type OfflineVoiceId,
  type VoiceOutEndedReport,
  type VoiceOutReadyReport,
  type VoiceOutTestResult
} from '@shared/ipc'
import {
  MIN_SPEAK_MS,
  VOICE_OUT_TEST_LINE,
  VOICE_OUT_VOICES,
  decideVoiceOutTest,
  pttWatchdogMs,
  pttWindow,
  resolveVoiceOutSynth,
  speakKeyVk,
  type VoiceOutEngine
} from '@shared/voice-out'
import { synthesizeEdge } from './edge'
import { synthesizeOffline } from './offline'
import { synthesizeSovits } from './sovits'
import { loadSettings } from '../settings'
import { getPttKeySender } from '../input/ptt-key'
import { getVoiceOutWindow } from '../../windows/voice-out'
import { getOverlayManager } from '../../windows/overlay'

/** 窗口侧枚举设备 + setSinkId + 解码读时长的总预算（页面里 metadata 自己还有 8 秒）。 */
const READY_TIMEOUT_MS = 15_000

/** 顺序递增的请求号：窗口只认当前这一单，旧单的 READY/ENDED 一律忽略。 */
let nextRequestId = 1

/**
 * 合成失败时浮层上的提示：引擎不同，失败的原因域也不同，别把「断网」误报给离线/GV 用户。
 * 失败一律静默跳过这句（不念、不按键），绝不回退系统嗓子。
 */
const SYNTH_FAIL_HINT: Record<VoiceOutEngine, string> = {
  edge: 'Edge 合成失败（断网或接口不可用），这句不出声',
  offline: '离线引擎合成失败（模型没装好或推理失败），这句不出声',
  sovits: 'GV 合成失败（api_v2 不在或参考没配），这句不出声'
}

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

/**
 * 「测试声出」的最小闭环：固定英文句 → 按设置里的声出引擎合成（Edge 英文占位 /
 * 离线本地 / GV 音色包）→ 所选输出设备（VB-Cable）→ 自动按住说话键播完 → 松开。
 * 合成失败不念也不按键；ENDED 没回来也不能把键按死。
 */
class VoiceOutService {
  private chain: Promise<VoiceOutTestResult> = Promise.resolve({ ok: true, durationMs: null, hint: null })

  /** 串行：连点测试按钮必须排队，两份音频、两组按键事件绝不能叠在一起。 */
  test(): Promise<VoiceOutTestResult> {
    const next = (): Promise<VoiceOutTestResult> => this.run()
    this.chain = this.chain.then(next, next)
    return this.chain
  }

  private async run(): Promise<VoiceOutTestResult> {
    const settings = loadSettings()
    const synth = resolveVoiceOutSynth(
      settings.ttsOutEngine,
      settings.ttsOutVoice,
      VOICE_OUT_TEST_LINE
    )
    let audioOrNull: Buffer | null
    if (synth.engine === 'offline') {
      audioOrNull = await synthesizeOffline(
        VOICE_OUT_TEST_LINE,
        synth.voice as OfflineVoiceId,
        settings.ttsRate
      )
    } else if (synth.engine === 'sovits') {
      // GV：音色由参考音频/音色包权重决定（切换复用现有 sovits 管线），语言看文本本身。
      audioOrNull = await synthesizeSovits(VOICE_OUT_TEST_LINE, settings.ttsRate, synth.lang)
    } else {
      audioOrNull = await synthesizeEdge(
        VOICE_OUT_TEST_LINE,
        synth.voice,
        settings.ttsRate,
        settings.ttsPitch,
        VOICE_OUT_VOICES
      )
    }
    const plan = decideVoiceOutTest(audioOrNull !== null, VOICE_OUT_TEST_LINE, synth)
    if (!plan.speak || audioOrNull === null) {
      const error = plan.skip === 'synth-failed' ? SYNTH_FAIL_HINT[synth.engine] : '测试句为空'
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
    const vk = speakKeyVk(settings.ttsSpeakKey)
    let keyError: string | undefined
    let keyHeld = false
    if (vk === null) {
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
}

let service: VoiceOutService | null = null

export function getVoiceOutService(): VoiceOutService {
  if (!service) service = new VoiceOutService()
  return service
}
