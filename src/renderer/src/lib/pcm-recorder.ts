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
  /** 取走攒下的 PCM 并清空缓冲；设备还开着，下一次按下可以接着用（麦克风复用）。 */
  take(): PcmChunks
  /** 闲置挂起：图还在、设备还开着，但不再收音频——闲置租约里不白占 CPU。 */
  suspend(): void
  /** 从闲置回到录音，顺手清掉挂起期间残留的那半段。 */
  resume(): void
  /**
   * 换一块 PCM 的监听者（#96 电平条）：挂起的流是上一次开麦时建的，
   * 监听者只能换不能重绑——否则麦克风复用时电平条永远是静止的。
   */
  setChunkListener(listener: ((chunk: Float32Array) => void) | null): void
  /** 拆图并交出攒下的 PCM（= take + close）；重复调用安全，之后返回空段。 */
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
  // 可变引用：挂起的流被复用时 setChunkListener 换掉它，不用重建音频图。
  let listener = onChunk
  let chunks: Float32Array[] = []
  let ctx: AudioContext
  let node: ScriptProcessorNode
  try {
    ctx = new AudioContext()
    node = ctx.createScriptProcessor(CHUNK_FRAMES, 1, 1)
    node.onaudioprocess = (event): void => {
      const input = event.inputBuffer.getChannelData(0)
      chunks.push(new Float32Array(input))
      listener?.(input)
    }
    ctx.createMediaStreamSource(stream).connect(node)
    node.connect(ctx.destination)
  } catch (err) {
    stream.getTracks().forEach((track) => track.stop())
    throw err
  }
  let stopped = false
  const take = (): PcmChunks => {
    const out = { chunks, sampleRate: ctx.sampleRate }
    chunks = []
    return out
  }
  return {
    stream,
    get sampleRate(): number {
      return ctx.sampleRate
    },
    take,
    suspend(): void {
      if (stopped) return
      // 只停音频线程，设备仍开着：下一次按下不必再走一遍 getUserMedia（那才是「按了没反应」的来源）。
      void ctx.suspend().catch(() => undefined)
    },
    setChunkListener(next: ((chunk: Float32Array) => void) | null): void {
      listener = next ?? undefined
    },
    resume(): void {
      if (stopped) return
      take()
      void ctx.resume().catch(() => undefined)
    },
    stop(): PcmChunks {
      const out = take()
      if (!stopped) {
        stopped = true
        node.disconnect()
        stream.getTracks().forEach((track) => track.stop())
        void ctx.close().catch(() => undefined)
      }
      return out
    }
  }
}
