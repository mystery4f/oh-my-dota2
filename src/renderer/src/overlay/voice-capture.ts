import { recordingStageLine, type CaptureMode } from '@shared/hotkeys'
import type { CaptureEntry, VoiceChainSummary } from '@shared/ipc'
import { spokenStatusLine, type SpokenStatus } from '@shared/voice-out'
import { formatChainOverlay } from '@shared/voice-timing'
import { encodeWav16k } from '@shared/wav'
import { openMicStream } from '../lib/mic'

/** 录音上限：一条对讲顶多 20 秒，超时自动停——忘记停也不会一直占着麦克风。 */
const RECORD_MAX_MS = 20_000
/** 短于这个时长的录音直接丢：多半是误触。 */
const MIN_SPEECH_MS = 300
/** 静音阈值：whisper 对纯静音会幻觉出文本，先量 RMS 再决定送不送。 */
const SILENCE_RMS = 0.012

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
 * 语音对讲的录音腿：getUserMedia → ScriptProcessorNode 攒 PCM → 停止时
 * 转写（whisper.cpp）→ 翻译 → 声出，一键到底。
 * ScriptProcessorNode 已废弃但不需要额外 worklet 资产，多条 page 的构建里最省事。
 */
export function createVoiceCapture(sink: VoiceCaptureSink) {
  let recording = false
  let recordCtx: AudioContext | null = null
  let recordStream: MediaStream | null = null
  let recordNode: ScriptProcessorNode | null = null
  let recordChunks: Float32Array[] = []
  let recordTimer: ReturnType<typeof setTimeout> | null = null

  async function start(): Promise<void> {
    if (recording) return
    try {
      recordStream = await openMicStream()
    } catch (err) {
      const micError = '麦克风不可用（检查 Windows 隐私设置：允许桌面应用使用麦克风）'
      sink.pushRow({ id: `voice-err-${Date.now()}`, ts: Date.now(), original: '🎤 ' + micError, translated: null })
      sink.reportChain({ transcript: '', translated: null, spoken: false, stage: null, error: micError })
      console.error('overlay: getUserMedia failed', err)
      sink.stage('麦克风不可用', 2500)
      return
    }
    recordCtx = new AudioContext()
    const source = recordCtx.createMediaStreamSource(recordStream)
    recordNode = recordCtx.createScriptProcessor(4096, 1, 1)
    recordChunks = []
    recordNode.onaudioprocess = (event) => {
      recordChunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
    }
    source.connect(recordNode)
    recordNode.connect(recordCtx.destination)
    recording = true
    window.api.reportVoiceState(true)
    sink.stage(recordingStageLine(sink.voiceCaptureMode(), sink.voiceCaptureKey()))
    recordTimer = setTimeout(() => void stop(), RECORD_MAX_MS)
  }

  async function stop(): Promise<void> {
    if (!recording) return
    recording = false
    window.api.reportVoiceState(false)
    if (recordTimer) clearTimeout(recordTimer)
    recordTimer = null
    const rate = recordCtx?.sampleRate ?? 48_000
    recordNode?.disconnect()
    recordNode = null
    recordStream?.getTracks().forEach((track) => track.stop())
    recordStream = null
    const ctx = recordCtx
    recordCtx = null
    if (ctx) ctx.close().catch(() => undefined)
    const chunks = recordChunks
    recordChunks = []
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
    const result = await window.api.transcribeAudio(encodeWav16k(chunks, rate))
    const transcript = result.text.trim()
    if (!result.ok || !transcript) {
      const transcriptError = result.error ?? '未识别到语音'
      fail('🎤 ' + transcriptError, transcriptError, 2200)
      return
    }
    // 一键到底：识别文本先落一行（pending 压暗 + 「翻译中…」），译文与已播状态就地补进同一行。
    const rowId = `voice-${Date.now()}`
    sink.pushRow({ id: rowId, ts: Date.now(), original: '🎤 ' + transcript, translated: null, pending: true })
    sink.stage('翻译声出中…')
    const reply = await window.api.voiceReply(transcript)
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
      sink.patchRow({ id: rowId, spoken: spokenStatusLine(reply.spoken, reply.error) })
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
    // 结果已经写进那一行里了；「播没播」加一句，播了就带上这次的起播总时长——慢在哪一段一眼看得见。
    const detail = formatChainOverlay(reply.timing)
    const doneLine = reply.spoken ? (detail ? `已播 · ${detail}` : '已播') : reply.error ? '未播' : null
    // 带拆解的两行要多留一会儿才读得完：2 秒只够看一眼「已播」，五段数字根本来不及看。
    sink.stage(doneLine, detail ? 8000 : 2000)
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
    // 按住模式：按下开录、松开结束。内部有幂等守卫，重复信号不会翻面。
    start(): void {
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
