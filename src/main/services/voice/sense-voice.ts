import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { app } from 'electron'
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { OfflineStatus } from '@shared/ipc'

/**
 * SenseVoice-small 本地识别（sherpa-onnx 推理）。对标 whisper 的换型：专治带口音的
 * 中文普通话，非自回归出整句，自带标点与语序。模型不进安装包，首次使用时下载。
 *
 * 为什么和离线朗读一样单开 Node 子进程：sherpa 原生插件在 Electron 主进程里抛
 * `External buffers are not allowed`（N-API 外部缓冲被禁），纯 Node 正常。
 *
 * 模型文件（hf-mirror 直链，国内直连稳定）：
 *   model.int8.onnx ~228MB + tokens.txt ~309KB
 *   https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17
 * 手动放置同样认：把两个文件丢进 data\asr-models\sense-voice\ 即可（文件名保持原样）。
 */

const HF_BASE = 'https://hf-mirror.com/csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17/resolve/main'
/** 每个源的停滞超时：15 秒没有新字节就判死。GitHub 直连在国内经常「连得上、没字节」。 */
const STALL_MS = 15_000

export function senseVoiceDir(): string {
  return join(app.getPath('userData'), 'asr-models', 'sense-voice')
}

export function senseVoiceReady(): boolean {
  const dir = senseVoiceDir()
  return existsSync(join(dir, 'model.int8.onnx')) && existsSync(join(dir, 'tokens.txt'))
}

let nodeChecked = false
let nodePath: string | null = null

/** 与 offline.ts 同一条规矩：sherpa 原生插件只认真正的 node.exe。 */
function nodeBinary(): string | null {
  if (nodeChecked) return nodePath
  nodeChecked = true
  const candidates = [process.env.OHMYDOTA2_NODE, 'node'].filter((value): value is string => Boolean(value))
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-v'], { encoding: 'utf8', windowsHide: true })
    if (probe.status === 0) {
      nodePath = candidate
      return nodePath
    }
  }
  console.log('ASR_SV_NO_NODE', JSON.stringify({ tried: candidates }))
  return null
}

function workerScript(): string {
  // 探针从 out/main/index.js 起，app.getAppPath() 是 out/main，不能直接拼 resources；
  // 打包后在 resourcesPath 下（electron-builder.yml 的 extraResources 摆进去）。
  const candidates = [
    join(process.resourcesPath ?? '', 'asr-sensevoice-worker.cjs'),
    join(__dirname, '../../resources/asr-sensevoice-worker.cjs'),
    join(app.getAppPath(), 'resources/asr-sensevoice-worker.cjs')
  ]
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? candidates[candidates.length - 1]
}

let worker: ChildProcess | null = null
let workerSeq = 0
const workerPending = new Map<number, (reply: { ok: boolean; text?: string; err?: string }) => void>()

function ensureWorker(): ChildProcess {
  if (worker && !worker.killed) return worker
  const node = nodeBinary()
  if (!node) throw new Error('ASR_SV_NO_NODE')
  const child = spawn(node, [workerScript()], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  let buffer = ''
  child.stdout?.setEncoding('utf8')
  child.stdout?.on('data', (chunk: string) => {
    buffer += chunk
    let index = buffer.indexOf('\n')
    while (index >= 0) {
      const line = buffer.slice(0, index)
      buffer = buffer.slice(index + 1)
      index = buffer.indexOf('\n')
      try {
        const reply = JSON.parse(line) as { id: number; ok: boolean; text?: string; err?: string }
        const done = workerPending.get(reply.id)
        workerPending.delete(reply.id)
        done?.(reply)
      } catch {
        // 半行或噪声，丢掉。
      }
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    console.log('ASR_SV_WORKER_STDERR', JSON.stringify({ text: String(chunk).trim().slice(0, 300) }))
  })
  child.on('close', (code) => {
    console.log('ASR_SV_WORKER_EXIT', JSON.stringify({ code }))
    if (worker === child) worker = null
    for (const done of workerPending.values()) done({ ok: false, err: 'worker exited' })
    workerPending.clear()
  })
  worker = child
  return child
}

/** 转写一段 16k 单声道 PCM16 WAV。失败返回 null（调用方按「这句不识别」画错误行）。 */
export async function senseVoiceTranscribe(wavPath: string): Promise<{ text: string } | null> {
  if (!senseVoiceReady()) return null
  if (!nodeBinary()) return null
  const started = Date.now()
  try {
    const child = ensureWorker()
    const id = ++workerSeq
    const reply = await new Promise<{ ok: boolean; text?: string; err?: string }>((resolve) => {
      const timer = setTimeout(() => {
        workerPending.delete(id)
        resolve({ ok: false, err: 'timeout' })
      }, 15_000)
      workerPending.set(id, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
      child.stdin?.write(`${JSON.stringify({ id, wav: wavPath, dir: senseVoiceDir() })}\n`)
    })
    if (!reply.ok || typeof reply.text !== 'string') {
      console.log('ASR_SV_FAILED', JSON.stringify({ ms: Date.now() - started, err: reply.err ?? 'unknown' }))
      return null
    }
    console.log('ASR_SV_OK', JSON.stringify({ ms: Date.now() - started, chars: reply.text.length }))
    return { text: reply.text }
  } catch (err) {
    console.log('ASR_SV_FAILED', JSON.stringify({ ms: Date.now() - started, err: err instanceof Error ? err.message : String(err) }))
    return null
  }
}

export function senseVoiceStatus(): OfflineStatus {
  const dir = senseVoiceDir()
  const ready = senseVoiceReady()
  let bytes = 0
  if (ready) {
    try {
      bytes = statSync(join(dir, 'model.int8.onnx')).size + statSync(join(dir, 'tokens.txt')).size
    } catch {
      bytes = 0
    }
  }
  return {
    available: nodeBinary() !== null,
    ready,
    bytes,
    dir,
    downloading: downloadState.downloading,
    progress: downloadState.progress,
    error: downloadState.error
  }
}

const downloadState = { downloading: false, progress: 0, error: null as string | null }

/** 依次试镜像；全失败抛最后一个原因。hf-mirror 是国内直连，放第一。 */
async function downloadFile(urls: string[], target: string, onProgress: (ratio: number) => void): Promise<void> {
  let lastError = 'unknown'
  for (const url of urls) {
    const controller = new AbortController()
    let stall = setTimeout(() => controller.abort(), STALL_MS)
    try {
      const response = await fetch(url, { signal: controller.signal })
      if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
      const total = Number(response.headers.get('content-length') ?? 0)
      const chunks: Uint8Array[] = []
      let received = 0
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        chunks.push(chunk)
        received += chunk.length
        clearTimeout(stall)
        stall = setTimeout(() => controller.abort(), STALL_MS)
        if (total > 0) onProgress(received / total)
      }
      if (received === 0) throw new Error('no bytes')
      writeFileSync(target, Buffer.concat(chunks.map((c) => Buffer.from(c))))
      console.log('ASR_SV_DOWNLOAD_DONE', JSON.stringify({ url, bytes: received }))
      return
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      console.log('ASR_SV_DOWNLOAD_RETRY', JSON.stringify({ url, err: lastError }))
    } finally {
      clearTimeout(stall)
    }
  }
  throw new Error(lastError)
}

/**
 * 下载模型到数据目录。重复调用复用同一次下载；失败只写状态不抛——
 * 识别可以留在 whisper 上，不能把主进程拖崩。
 */
export async function ensureSenseVoiceModel(): Promise<OfflineStatus> {
  if (senseVoiceReady()) return senseVoiceStatus()
  if (downloadState.downloading) return senseVoiceStatus()
  downloadState.downloading = true
  downloadState.error = null
  downloadState.progress = 0
  const dir = senseVoiceDir()
  try {
    mkdirSync(dir, { recursive: true })
    const modelPath = join(dir, 'model.int8.onnx')
    const tokensPath = join(dir, 'tokens.txt')
    await downloadFile([`${HF_BASE}/model.int8.onnx`], modelPath, (ratio) => {
      downloadState.progress = ratio * 0.98
    })
    downloadState.progress = 0.98
    await downloadFile([`${HF_BASE}/tokens.txt`], tokensPath, (ratio) => {
      downloadState.progress = 0.98 + ratio * 0.02
    })
    downloadState.downloading = false
    downloadState.progress = 1
    console.log('ASR_SV_READY', JSON.stringify({ dir, bytes: senseVoiceStatus().bytes }))
    return senseVoiceStatus()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    downloadState.downloading = false
    downloadState.error = message
    console.log('ASR_SV_DOWNLOAD_FAILED', JSON.stringify({ err: message }))
    return senseVoiceStatus()
  }
}
