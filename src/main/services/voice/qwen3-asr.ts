import { app } from 'electron'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { OfflineStatus } from '@shared/ipc'
import { loadSettings } from '../settings'
import { downloadVoiceModel, voiceModelDir, voiceModelState } from './runtime'
import { sherpaNodeBinary, sherpaTranscribe } from './sherpa-asr'
/**
 * Qwen3-ASR 本地识别（sherpa-onnx 推理，0.6B int8）。阿里开源，中文实测准过
 * SenseVoice（FLEURS 普通话 CER 第一），官方方言列表点名支持湖南/东北/四川/粤语等，
 * 外加抗噪与极快语速——专治「口音重 + 游戏噪音」。代价是模型大（~980MB）且逐字
 * 生成，短句解码 1 秒级，打游戏可接受。
 *
 * 模型三条来路（按优先级）：微调转正的现役模型（asr-models/qwen3-asr）、
 * 手动解包的 tar 目录（asr-models/sherpa-onnx-*）、运行时应用内下载的底模
 * （voice-runtime/models/qwen3-asr，hf-mirror 按文件直下，#45）。
 */
/** 模型目录探测：现役（微调转正）→ tar 手动解包目录 → 运行时下载的底模。 */
export function qwen3AsrDir(): string {
  const root = join(app.getPath('userData'), 'asr-models')
  const canonical = join(root, 'qwen3-asr')
  if (existsSync(join(canonical, 'decoder.int8.onnx'))) return canonical
  try {
    for (const entry of readdirSync(root)) {
      if (/^sherpa-onnx-qwen3-asr/i.test(entry) && existsSync(join(root, entry, 'decoder.int8.onnx'))) {
        return join(root, entry)
      }
    }
  } catch {
    // 数据目录还没建，走运行时模型目录让状态面板显示目标路径。
  }
  // 手动解包的 tar 与微调转正的现役模型都不在时，用运行时下载的底模（#45 应用内下载）。
  const runtimeDir = voiceModelDir()
  if (existsSync(join(runtimeDir, 'decoder.int8.onnx'))) return runtimeDir
  return canonical
}

function qwen3Ready(): boolean {
  const dir = qwen3AsrDir()
  return (
    existsSync(join(dir, 'conv_frontend.onnx')) &&
    existsSync(join(dir, 'encoder.int8.onnx')) &&
    existsSync(join(dir, 'decoder.int8.onnx')) &&
    existsSync(join(dir, 'tokenizer', 'vocab.json')) &&
    existsSync(join(dir, 'tokenizer', 'merges.txt'))
  )
}

export function qwen3Status(): OfflineStatus {
  const dir = qwen3AsrDir()
  const ready = qwen3Ready()
  const state = voiceModelState()
  let bytes = 0
  if (ready) {
    try {
      bytes =
        statSync(join(dir, 'conv_frontend.onnx')).size +
        statSync(join(dir, 'encoder.int8.onnx')).size +
        statSync(join(dir, 'decoder.int8.onnx')).size
    } catch {
      bytes = 0
    }
  }
  return {
    available: sherpaNodeBinary() !== null,
    ready,
    bytes,
    dir,
    downloading: state.downloading,
    progress: state.progress,
    error: state.error
  }
}

/** 转写一段 16k 单声道 PCM16 WAV。失败返回 null（调用方按「这句不识别」画错误行）。 */
/** 转写一段 16k 单声道 PCM16 WAV，热词表从设置读（仅 Qwen3 注入）。失败返回 null。 */
export async function qwen3Transcribe(wavPath: string): Promise<{ text: string } | null> {
  if (!qwen3Ready()) return null
  if (!sherpaNodeBinary()) return null
  const settings = loadSettings()
  return sherpaTranscribe({ dir: qwen3AsrDir(), wav: wavPath, hotwords: settings.asrHotwords })
}

/**
 * 应用内下载 Qwen3 底模（hf-mirror 按文件直下，断点续传 + sha256 校验），
 * 代替旧的「丢 tar 包 + 点解压」手动流程；副作用与进度都在语音运行时模块。
 */
export async function ensureQwen3Model(): Promise<OfflineStatus> {
  if (qwen3Ready()) return qwen3Status()
  await downloadVoiceModel()
  return qwen3Status()
}
