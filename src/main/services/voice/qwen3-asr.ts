import { spawn } from 'node:child_process'
import { app } from 'electron'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import type { OfflineStatus } from '@shared/ipc'
import { loadSettings } from '../settings'
import { sherpaNodeBinary, sherpaTranscribe } from './sherpa-asr'

/**
 * Qwen3-ASR 本地识别（sherpa-onnx 推理，0.6B int8）。阿里开源，中文实测准过
 * SenseVoice（FLEURS 普通话 CER 第一），官方方言列表点名支持湖南/东北/四川/粤语等，
 * 外加抗噪与极快语速——专治「口音重 + 游戏噪音」。代价是模型大（~980MB）且逐字
 * 生成，短句解码 1 秒级，打游戏可接受。
 *
 * 模型不自动下载（GitHub release 走国内网络不稳），流程是：
 * 把 sherpa-onnx-qwen3-asr-*.tar.bz2 丢进 data\asr-models\，面板点「解压」，
 * 用系统自带 tar.exe（Windows 10 1803+）解开；手动解开成目录也认（扫描目录名）。
 */

/** 模型目录探测：先认规范名 qwen3-asr（手动放置），再认 tar 包解出来的原始目录名。 */
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
    // 数据目录还没建，走规范名让状态面板显示目标路径。
  }
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
    downloading: extractState.busy,
    progress: extractState.progress,
    error: extractState.error
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

const extractState = { busy: false, progress: 0, error: null as string | null }

/**
 * 把用户放进 data\asr-models\ 的 sherpa-onnx-qwen3-asr-*.tar.bz2 解开（系统 tar.exe）。
 * 失败只写状态不抛——识别可以留在 whisper 上，不能把主进程拖崩。
 */
export async function ensureQwen3Model(): Promise<OfflineStatus> {
  if (qwen3Ready()) return qwen3Status()
  if (extractState.busy) return qwen3Status()
  const root = join(app.getPath('userData'), 'asr-models')
  let tarball: string | null = null
  try {
    for (const entry of readdirSync(root)) {
      if (/qwen3-asr.*\.tar\.bz2$/i.test(entry)) {
        tarball = join(root, entry)
        break
      }
    }
  } catch {
    // 目录不存在，tarball 保持 null。
  }
  if (!tarball) {
    extractState.error = '没找到压缩包：把下载的 sherpa-onnx-qwen3-asr-*.tar.bz2 放进 data\\asr-models\\ 再点解压'
    return qwen3Status()
  }
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  if (!existsSync(tar)) {
    extractState.error = '系统缺少 tar.exe（需 Windows 10 1803+），手动解压到 data\\asr-models\\ 也可以'
    return qwen3Status()
  }
  extractState.busy = true
  extractState.error = null
  extractState.progress = 0.05
  try {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(tar, ['-xjf', tarball, '-C', root], { stdio: 'ignore', windowsHide: true })
      const killer = setTimeout(() => {
        child.kill()
        reject(new Error('解压超时（10 分钟）'))
      }, 600_000)
      child.on('error', (err) => {
        clearTimeout(killer)
        reject(err)
      })
      child.on('close', (code) => {
        clearTimeout(killer)
        if (code === 0) resolve()
        else reject(new Error(`tar 退出码 ${code}`))
      })
    })
    extractState.busy = false
    extractState.progress = 1
    console.log('ASR_QW_READY', JSON.stringify({ dir: qwen3AsrDir(), bytes: qwen3Status().bytes }))
    return qwen3Status()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    extractState.busy = false
    extractState.error = message
    console.log('ASR_QW_EXTRACT_FAILED', JSON.stringify({ err: message }))
    return qwen3Status()
  }
}
