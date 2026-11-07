import type { VoiceTranscribeResult } from '@shared/ipc'
import { qwen3Status, qwen3Transcribe } from './qwen3-asr'

/**
 * 识别入口（#45 后只剩 Qwen3 一条腿）：没就绪怎么说、结果怎么归一，都在这一处。
 * 此前 whisper / qwen3 双引擎各说各话（whisper 回 {ok,text,error}、Qwen3 回 text|null），
 * 在这里统一成 VoiceTranscribeResult，调用方拿到的永远是一个形状。
 */
const QWEN3_NOT_READY = 'Qwen3 模型未就绪：到面板「识别引擎」点「下载模型」（或用训练窗口微调换模）'

export async function transcribeWav(wavPath: string): Promise<VoiceTranscribeResult> {
  if (!qwen3Status().ready) return { ok: false, text: '', error: QWEN3_NOT_READY }
  const result = await qwen3Transcribe(wavPath)
  return result ? { ok: true, text: result.text } : { ok: false, text: '', error: 'Qwen3 识别失败' }
}
