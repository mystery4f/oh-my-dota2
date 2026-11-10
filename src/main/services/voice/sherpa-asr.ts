import { errorMessage } from '@shared/errors'
import type { AsrSherpaKind } from '@shared/asr/engines'
import { voiceRuntimeNodeBinary } from './runtime'
import { createNdjsonWorker, type NdjsonReply } from './worker'

/**
 * sherpa-onnx 识别（Qwen3-ASR）的推理管道：唯一引擎共用一个 Node 子进程
 * （resources/asr-sherpa-worker.cjs），服务层只管模型目录与状态。
 * 进程协议（spawn/行缓冲/id 派发/close 守卫）收口在 ./worker，这里只声明
 * 脚本、超时和日志标签。为什么单开进程：sherpa-onnx 的原生插件在 Electron
 * 主进程里抛 `External buffers are not allowed`（N-API 外部缓冲被禁），纯 Node 下正常。
 */

/** 推理请求：dir 是模型目录，hotwords 是热词表串（仅 Qwen3 支持，可空）。 */
export interface SherpaAsrRequest {
  /** 引擎适配器键（worker 里 ASR_KINDS 的键），来自共享引擎表，别自己拼字符串。 */
  kind: AsrSherpaKind
  dir: string
  wav: string
  hotwords?: string
}

interface SherpaReply extends NdjsonReply {
  text?: string
}

const worker = createNdjsonWorker<SherpaReply>({
  script: 'asr-sherpa-worker.cjs',
  timeoutMs: 15_000,
  tag: 'ASR_SHERPA'
})

export function sherpaNodeBinary(): string | null {
  return voiceRuntimeNodeBinary()
}

/** 转写一段 16k 单声道 PCM16 WAV。失败返回 null（调用方按「这句不识别」画错误行）。 */
export async function sherpaTranscribe(request: SherpaAsrRequest): Promise<{ text: string } | null> {
  const started = Date.now()
  try {
    const reply = await worker.request({ kind: request.kind, wav: request.wav, dir: request.dir, hotwords: request.hotwords ?? '' })
    if (!reply.ok || typeof reply.text !== 'string') {
      console.log('ASR_SHERPA_FAILED', JSON.stringify({ ms: Date.now() - started, err: reply.err ?? 'unknown' }))
      return null
    }
    console.log('ASR_SHERPA_OK', JSON.stringify({ ms: Date.now() - started, chars: reply.text.length }))
    return { text: reply.text }
  } catch (err) {
    console.log('ASR_SHERPA_FAILED', JSON.stringify({ ms: Date.now() - started, err: errorMessage(err) }))
    return null
  }
}

/** 换模型后把常驻 worker 杀掉：旧识别器连着旧模型文件，杀掉后下一次转写会用新目录重新拉起。 */
export function resetSherpaWorker(): void {
  worker.reset()
}
