import type { VoiceTranscribeResult } from '@shared/ipc'
import { activeAsrModel, engineSpecOf, transcribeAsr } from './asr-model'

/**
 * 识别入口：没就绪怎么说、结果怎么归一，都在这一处。
 * 引擎与模型的判断不在这个文件里——现役是哪份由 asr-model 的注册表决定，
 * 这里只负责把「没有模型 / 这份没就绪 / 这句识别失败」翻译成用户能照着做的话。
 */
const NO_MODEL = '没有可用的识别模型：到面板「语音」下载模型，或把模型目录放进 asr-models/'

export async function transcribeWav(wavPath: string): Promise<VoiceTranscribeResult> {
  const model = activeAsrModel()
  if (!model) return { ok: false, text: '', error: NO_MODEL }
  const spec = engineSpecOf(model)
  if (!model.ready) {
    return {
      ok: false,
      text: '',
      error: `${spec.label} 未就绪：到面板「语音」点「下载模型」（或用训练面板微调换模）`
    }
  }
  const result = await transcribeAsr(wavPath)
  return result ? { ok: true, text: result.text } : { ok: false, text: '', error: `${spec.label} 识别失败` }
}
