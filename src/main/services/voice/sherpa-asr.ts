import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

/**
 * sherpa-onnx 识别（Qwen3-ASR）的推理管道：唯一引擎共用一个 Node 子进程
 * （resources/asr-sherpa-worker.cjs），服务层只管模型目录与状态。
 *
 * 为什么单开进程：sherpa-onnx 的原生插件在 Electron 主进程里抛
 * `External buffers are not allowed`（N-API 外部缓冲被禁），纯 Node 下正常。
 */

/** 推理请求：dir 是模型目录，hotwords 是热词表串（仅 Qwen3 支持，可空）。 */
export interface SherpaAsrRequest {
  dir: string
  wav: string
  hotwords?: string
}

let nodeChecked = false
let nodePath: string | null = null

/** 与 offline.ts 同一条规矩：sherpa 原生插件只认真正的 node.exe。 */
export function sherpaNodeBinary(): string | null {
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
  console.log('ASR_SHERPA_NO_NODE', JSON.stringify({ tried: candidates }))
  return null
}

function workerScript(): string {
  // 探针从 out/main/index.js 起，app.getAppPath() 是 out/main，不能直接拼 resources；
  // 打包后在 resourcesPath 下（electron-builder.yml 的 extraResources 摆进去）。
  const candidates = [
    join(process.resourcesPath ?? '', 'asr-sherpa-worker.cjs'),
    join(__dirname, '../../resources/asr-sherpa-worker.cjs'),
    join(app.getAppPath(), 'resources/asr-sherpa-worker.cjs')
  ]
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? candidates[candidates.length - 1]
}

let worker: ChildProcess | null = null
let workerSeq = 0
const workerPending = new Map<number, (reply: { ok: boolean; text?: string; err?: string }) => void>()

function ensureWorker(): ChildProcess {
  if (worker && !worker.killed) return worker
  const node = sherpaNodeBinary()
  if (!node) throw new Error('ASR_SHERPA_NO_NODE')
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
    console.log('ASR_SHERPA_WORKER_STDERR', JSON.stringify({ text: String(chunk).trim().slice(0, 300) }))
  })
  child.on('close', (code) => {
    console.log('ASR_SHERPA_WORKER_EXIT', JSON.stringify({ code }))
    if (worker === child) worker = null
    for (const done of workerPending.values()) done({ ok: false, err: 'worker exited' })
    workerPending.clear()
  })
  worker = child
  return child
}

/** 转写一段 16k 单声道 PCM16 WAV。失败返回 null（调用方按「这句不识别」画错误行）。 */
export async function sherpaTranscribe(request: SherpaAsrRequest): Promise<{ text: string } | null> {
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
      child.stdin?.write(`${JSON.stringify({ id, wav: request.wav, dir: request.dir, hotwords: request.hotwords ?? '' })}\n`)
    })
    if (!reply.ok || typeof reply.text !== 'string') {
      console.log('ASR_SHERPA_FAILED', JSON.stringify({ ms: Date.now() - started, err: reply.err ?? 'unknown' }))
      return null
    }
    console.log('ASR_SHERPA_OK', JSON.stringify({ ms: Date.now() - started, chars: reply.text.length }))
    return { text: reply.text }
  } catch (err) {
    console.log('ASR_SHERPA_FAILED', JSON.stringify({ ms: Date.now() - started, err: err instanceof Error ? err.message : String(err) }))
    return null
  }
}
