import { recordingStageLine, type CaptureMode } from '@shared/hotkeys'
import type { CaptureEntry, VoiceChainSummary } from '@shared/ipc'
import { spokenStatusLine, type SpokenStatus } from '@shared/voice-out'
import { formatChainOverlay } from '@shared/voice-timing'
import { encodeWav16k } from '@shared/wav'
import { describeCaptureDevice } from '../lib/mic'
import { startPcmRecorder, type PcmRecorder } from '../lib/pcm-recorder'

/** 录音上限：一条对讲顶多 20 秒，超时自动停——忘记停也不会一直占着麦克风。 */
const RECORD_MAX_MS = 20_000
/** 短于这个时长的录音直接丢：多半是误触。 */
const MIN_SPEECH_MS = 300
/** 静音阈值：whisper 对纯静音会幻觉出文本，先量 RMS 再决定送不送。 */
const SILENCE_RMS = 0.012
/** 开麦超时：设备被占用或驱动卡住时 getUserMedia 可能永远不落定，超时判负，别让对讲从此挂死。 */
const MIC_OPEN_TIMEOUT_MS = 3000

/**
 * 带超时的开麦。超时判负之后流才开成功的：立刻关掉，别留一路开着的话筒。
 */
async function openRecorder(): Promise<PcmRecorder> {
  let settled = false
  return new Promise<PcmRecorder>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      reject(new Error('麦克风打开超时'))
    }, MIC_OPEN_TIMEOUT_MS)
    void startPcmRecorder().then(
      (rec) => {
        if (settled) {
          rec.stop()
          return
        }
        settled = true
        clearTimeout(timer)
        resolve(rec)
      },
      (err: unknown) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    )
  })
}

/** 语音行就地补齐所需的全部信息：同一行从「识别原文」长成「译文 + 已播」。 */
export interface VoiceRowPatch {
  id: string
  translated?: string | null
  error?: string
  spoken?: SpokenStatus
}

/** 浮层接住语音事件的出口：行进账本、阶段行给反馈、链路结果广播给面板。 */
export interface VoiceCaptureSink {
  pushRow(entry: CaptureEntry): void
  patchRow(patch: VoiceRowPatch): void
  stage(label: string | null, holdMs?: number): void
  reportChain(result: VoiceChainSummary): void
  voiceCaptureKey(): string
  /** 按住 / 敲一下：横幅文案靠它区分「松开结束」与「再按一下结束」。 */
  voiceCaptureMode(): CaptureMode
}

/**
 * 语音对讲的录音腿：共享录音图（lib/pcm-recorder）攒 PCM → 停止时
 * 转写（whisper.cpp）→ 翻译 → 声出，一键到底。
 */
export function createVoiceCapture(sink: VoiceCaptureSink) {
  let recording = false
  let recorder: PcmRecorder | null = null
  /** 本次录音实际用的输入设备（label|id 前 8 位），随转写一起交给主进程进日志。 */
  let recordDevice = ''
  let recordTimer: ReturnType<typeof setTimeout> | null = null
  /** 开麦进行中：松开（HOLD 0）可能赶在 recording=true 之前到。 */
  let starting = false
  /** 开麦期间收到的松开：开麦回来后立刻收掉这条录音，不让它变成「松开还在录」。 */
  let stopWhileStarting = false

  async function start(): Promise<void> {
    if (recording || starting) return
    starting = true
    stopWhileStarting = false
    let opened: PcmRecorder
    try {
      opened = await openRecorder()
    } catch (err) {
      starting = false
      const timedOut = err instanceof Error && err.message === '麦克风打开超时'
      const micError = timedOut
        ? '麦克风打开超时（设备被占用或无响应）'
        : '麦克风不可用（检查 Windows 隐私设置：允许桌面应用使用麦克风）'
      sink.pushRow({ id: `voice-err-${Date.now()}`, ts: Date.now(), original: '🎤 ' + micError, translated: null })
      sink.reportChain({ transcript: '', translated: null, spoken: false, stage: null, error: micError })
      console.error('overlay: getUserMedia failed', err)
      sink.stage(timedOut ? '麦克风打开超时' : '麦克风不可用', 2500)
      return
    }
    recorder = opened
    starting = false
    if (stopWhileStarting) {
      // 松开赶在开麦完成之前：这条停不能装没看见——丢了它，观感就是「松开了还在录」。
      stopWhileStarting = false
      opened.stop()
      recorder = null
      fail('松开太快，麦克风还没就绪，已忽略', '松开时麦克风还没就绪', 1800)
      return
    }
    recording = true
    window.api.reportVoiceState(true)
    sink.stage(recordingStageLine(sink.voiceCaptureMode(), sink.voiceCaptureKey()))
    recordTimer = setTimeout(() => void stop(), RECORD_MAX_MS)
    // 设备名只进日志：挪到 recording=true 之后异步补齐，别再撑大「松开撞上开麦」的竞态窗口。
    const openedRef = opened
    void describeCaptureDevice(openedRef.stream)
      .then((device) => {
        if (recorder === openedRef) recordDevice = device
      })
      .catch(() => undefined)
  }

  async function stop(): Promise<void> {
    if (starting) {
      // 开麦还没回来：松开先记账，等开麦回来由 start 结算——直接丢掉就是「松开还在录」。
      stopWhileStarting = true
      return
    }
    if (!recording) return
    recording = false
    window.api.reportVoiceState(false)
    if (recordTimer) clearTimeout(recordTimer)
    recordTimer = null
    const { chunks, sampleRate: rate } = recorder?.stop() ?? { chunks: [], sampleRate: 48_000 }
    recorder = null
    const frames = chunks.reduce((total, chunk) => total + chunk.length, 0)
    if (frames < (rate * MIN_SPEECH_MS) / 1000) {
      fail('录音太短，已忽略', '录音太短（不足 0.3 秒）', 1800)
      return
    }
    let energy = 0
    for (const chunk of chunks) {
      for (let i = 0; i < chunk.length; i += 1) energy += chunk[i] * chunk[i]
    }
    const rms = Math.sqrt(energy / frames)
    if (rms < SILENCE_RMS) {
      fail(`没有检测到语音（音量 RMS ${rms.toFixed(4)}）`, `没有检测到语音（音量 RMS ${rms.toFixed(4)}）`, 1800)
      return
    }
    sink.stage('识别中…')
    const result = await window.api.transcribeAudio(encodeWav16k(chunks, rate), recordDevice)
    const transcript = result.text.trim()
    if (!result.ok || !transcript) {
      const transcriptError = result.error ?? '未识别到语音'
      fail('🎤 ' + transcriptError, transcriptError, 2200)
      return
    }
    // 一键到底：识别文本先落一行，这条链的进度由行自己的留痕报（译/合/起/播），
    // 底部阶段行只留链两端：识别中的「识别中…」和结束时的「已播/未播」——中间再报一遍就是两句状态打架。
    const rowId = `voice-${Date.now()}`
    sink.pushRow({ id: rowId, ts: Date.now(), original: '🎤 ' + transcript, translated: null, pending: true })
    sink.stage(null)
    const reply = await window.api.voiceReply({ text: transcript, rowId, asrMs: result.asrMs, mic: result.mic })
    if (reply.translated) {
      sink.patchRow({
        id: rowId,
        translated: reply.translated,
        error: reply.stage === 'translate' ? (reply.error ?? '翻译失败') : undefined
      })
    } else if (reply.stage !== 'skipped') {
      sink.patchRow({ id: rowId, error: reply.error ?? '翻译失败' })
    }
    if (reply.stage === 'voice-out' || reply.spoken) {
      // 耗时拆解挂在那一行自己身上：条目还在，数字就在——阶段行两秒后清掉也不带走它。
      const base = spokenStatusLine(reply.spoken, reply.error)
      const detail = formatChainOverlay(reply.timing)
      sink.patchRow({ id: rowId, spoken: detail === null ? base : { ...base, text: `${base.text} · ${detail}` } })
    }
    sink.reportChain({
      transcript,
      translated: reply.translated,
      spoken: reply.spoken,
      stage: reply.stage,
      error: reply.error,
      timing: reply.timing,
      // 面板纠错凭这张票取原音：同一句说两遍时文本一样，只有票分得清是哪一段录音。
      utteranceId: result.utteranceId
    })
    // 结果已经写进那一行里了；这里只补一句「播没播」——耗时数字在条目里，不在这里重复。
    // 阶段行只说结局：数字在上面的条目里，不需要抢两行的高度。
    sink.stage(reply.spoken ? '已播' : reply.error ? '未播' : null, 2000)
  }

  /** 失败也落一行 + 面板可见的链路结果：按了没反应比报错更糟。 */
  function fail(rowText: string, error: string, stageHoldMs: number): void {
    sink.pushRow({ id: `voice-err-${Date.now()}`, ts: Date.now(), original: rowText, translated: null })
    sink.reportChain({ transcript: '', translated: null, spoken: false, stage: null, error })
    sink.stage(error, stageHoldMs)
  }

  return {
    toggle(): void {
      if (recording) void stop()
      else void start()
    },
    // 按住模式：按下开录、松开结束。开麦未落定时按下/松开记为意图，落定时按最后一条结算。
    start(): void {
      if (starting) {
        // 松开后马上又按下（重按重试）：后到的按下赢，撤销挂起的停，开麦回来直接进录音。
        stopWhileStarting = false
        return
      }
      if (recording) return
      void start()
    },
    stop(): void {
      void stop()
    },
    get recording(): boolean {
      return recording
    }
  }
}
