import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VoiceTranscribeResult } from '@shared/ipc'
import { activeAsrModel, engineSpecOf, transcribeAsr } from './asr-model'
import { noteAsrRun } from './chain-timing'
import { stashUtterance } from './corrections'
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

/**
 * 对讲链路的识别段深入口：写盘、转写、记账、发票据一趟做完。
 * 时序协议是这里的实现细节，不该漏到 handler 层——漏一行 noteAsrRun，
 * totalMs 就会静默从「识别开始」漂成「翻译开始」，这正是收拢它的原因。
 */
export async function transcribeForVoice(wavBase64: string, micLabel?: string): Promise<VoiceTranscribeResult> {
  const base64 = String(wavBase64 ?? '')
  if (!base64) return { ok: false, text: '', error: '音频为空' }
  const dir = join(app.getPath('userData'), 'voice')
  mkdirSync(dir, { recursive: true })
  const wavPath = join(dir, 'utterance.wav')
  const wav = Buffer.from(base64, 'base64')
  writeFileSync(wavPath, wav)
  // 这一段就是「识别耗时」；紧接着的 voiceReply 会把票领走（60 秒内有效）。
  const startedAt = Date.now()
  const result = await transcribeWav(wavPath)
  if (result.ok) noteAsrRun(startedAt, Date.now() - startedAt, String(micLabel ?? ''))
  // #66：这句的原音留在内存里，并把票据（utteranceId）随结果交给渲染层——语音页纠错在
  // 另一个窗口、时间也更晚，而 utterance.wav 下一句就被覆盖了。票据而不是文本：同一句说两遍
  // 文本一样、录音不同，按文本找会把较新那段音配到较旧那一行上。
  if (!result.ok || !result.text.trim()) return result
  const utteranceId = stashUtterance(result.text, wav)
  return utteranceId ? { ...result, utteranceId } : result
}
