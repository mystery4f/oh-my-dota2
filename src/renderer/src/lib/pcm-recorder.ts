import { openMicStream } from './mic'

/** 两个调用方原本就是 4096 帧一段、单声道；合图后参数只在这里出现一次。 */
const CHUNK_FRAMES = 4096

/** 停录时交出的 PCM 段和实际采样率（AudioContext 决定，一般 48000）。 */
export interface PcmChunks {
  chunks: Float32Array[]
  sampleRate: number
}

export interface PcmRecorder {
  /** 原始输入流：describeCaptureDevice 需要它来报「这次开的哪台麦克风」。 */
  readonly stream: MediaStream
  readonly sampleRate: number
  /** 拆图并交出攒下的 PCM；重复调用安全，之后返回空段。 */
  stop(): PcmChunks
}

/**
 * 全应用共用的 PCM 录音图：getUserMedia → ScriptProcessorNode 攒段 → 拆图交账。
 * 判定不进图——训练页的逐段 RMS 自动停、对讲的静音/太短过滤都是调用方自己的语义，
 * 图只负责「把麦克风里的 PCM 一段段攒下来」这一件事。
 * ScriptProcessorNode 已废弃但不需要额外 worklet 资产，多条 page 的构建里最省事。
 * 麦克风拿不到或图建不起来时清干净再抛错，错误文案归调用方。
 */
export async function startPcmRecorder(onChunk?: (chunk: Float32Array) => void): Promise<PcmRecorder> {
  const stream = await openMicStream()
  const chunks: Float32Array[] = []
  let ctx: AudioContext
  let node: ScriptProcessorNode
  try {
    ctx = new AudioContext()
    node = ctx.createScriptProcessor(CHUNK_FRAMES, 1, 1)
    node.onaudioprocess = (event): void => {
      const input = event.inputBuffer.getChannelData(0)
      chunks.push(new Float32Array(input))
      onChunk?.(input)
    }
    ctx.createMediaStreamSource(stream).connect(node)
    node.connect(ctx.destination)
  } catch (err) {
    stream.getTracks().forEach((track) => track.stop())
    throw err
  }
  let stopped = false
  return {
    stream,
    get sampleRate(): number {
      return ctx.sampleRate
    },
    stop(): PcmChunks {
      if (!stopped) {
        stopped = true
        node.disconnect()
        stream.getTracks().forEach((track) => track.stop())
        void ctx.close().catch(() => undefined)
      }
      return { chunks, sampleRate: ctx.sampleRate }
    }
  }
}
