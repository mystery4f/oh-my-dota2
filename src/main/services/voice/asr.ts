import type { VoiceTranscribeResult } from '@shared/ipc'
import { loadSettings } from '../settings'
import { qwen3Status, qwen3Transcribe } from './qwen3-asr'
import { getWhisperAdapter } from './whisper'

/**
 * 识别引擎的适配器：选哪个引擎、没就绪怎么说、结果怎么归一，都在这一处。
 *
 * 麦克风录音和训练窗口的「识别测试」此前各写一遍 if/else，同一句提醒已经分叉成两种说法
 * （一个让人去下 tar.bz2、一个只让人点解压）。引擎开关一旦落到调用点，用户看到的话就各家各说；
 * 三个引擎的结果形状也不一样（whisper 回 {ok,text,error}、Qwen3 回 text|null），
 * 在这里统一成 VoiceTranscribeResult，调用方拿到的永远是一个形状。
 */
const QWEN3_NOT_READY = 'Qwen3 模型未就绪：下载 tar.bz2 放进 data\\asr-models\\，到面板「识别引擎」点解压'

export async function transcribeWav(wavPath: string, language = 'zh'): Promise<VoiceTranscribeResult> {
  if (loadSettings().asrEngine === 'qwen3') {
    if (!qwen3Status().ready) return { ok: false, text: '', error: QWEN3_NOT_READY }
    const result = await qwen3Transcribe(wavPath)
    return result ? { ok: true, text: result.text } : { ok: false, text: '', error: 'Qwen3 识别失败' }
  }
  return getWhisperAdapter().transcribe(wavPath, language)
}
