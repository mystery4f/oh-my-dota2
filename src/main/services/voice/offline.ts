import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { app } from 'electron'
import type { OfflineStatus } from '../../../shared/ipc'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { offlineVoicePreset, type OfflineVoiceId } from '../../../shared/ipc'

/**
 * 离线朗读引擎：sherpa-onnx + MeloTTS（vits-melo-tts-zh_en）。
 *
 * 为什么不是 Edge：Edge 每句都要一次跨境往返（实测 700–1639 ms）；离线模型在本机 0.9–1.2 s，
 * 44.1 kHz。选型实测见 docs/BENCH.md：Matcha-zh-baker 只有 22.05 kHz、音色发闷（用户当场否掉），
 * vits-zh-aishell3 有 174 个说话人但采样率只有 8 kHz（电话音质），Kokoro int8 最慢。
 *
 * 模型不进安装包：MeloTTS 为 MIT，但 fp32 模型 163 MB，会推翻 93 MB 的安装包体积。
 * 首次选用离线引擎时才下载到 `data/tts-models/`，解压用系统自带的 tar.exe（Win10+ 是 bsdtar，
 * 认 bz2），不额外引入解压依赖。
 */

interface ModelFiles {
  dir: string
  archive: string
  required: string[]
  /** 多说话人模型固定用哪一个嗓子；单说话人模型恒为 0。 */
  sid: number
}

const MODEL_FILES: Record<OfflineVoiceId, ModelFiles> = {
  keqing: {
    dir: 'vits-zh-hf-keqing',
    archive: 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/vits-zh-hf-keqing.tar.bz2',
    required: ['keqing.onnx', 'tokens.txt', 'lexicon.txt'],
    sid: 70
  }
}

function modelFiles(voice: OfflineVoiceId): ModelFiles {
  return MODEL_FILES[voice] ?? MODEL_FILES.keqing
}


export function offlineModelDir(voice: OfflineVoiceId = 'keqing'): string {
  return join(app.getPath('userData'), 'tts-models', modelFiles(voice).dir)
}

export function offlineReady(voice: OfflineVoiceId = 'keqing'): boolean {
  const dir = offlineModelDir(voice)
  if (!modelFiles(voice).required.every((name) => existsSync(join(dir, name)))) return false
  return existsSync(join(dir, 'dict'))
}

function dirBytes(dir: string): number {
  let total = 0
  try {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name)
      const info = statSync(path)
      total += info.isDirectory() ? dirBytes(path) : info.size
    }
  } catch {
    // 目录还没建就是 0。
  }
  return total
}

let state: OfflineStatus = {
  // 模块求值时不能调 offlineNodeBinary()：它闭包的 nodeChecked/nodePath 还在 TDZ，
  // 会抛 'Cannot access nodeChecked before initialization'。available 由 offlineStatus() 现算。
  available: false,
  ready: offlineReady(),
  bytes: dirBytes(offlineModelDir()),
  // 不能在这里缓存路径：模块在被 import 时求值，而 userData 可能还没被 applyPortableUserData 重定向。
  dir: '',
  downloading: false,
  progress: 0,
  error: null
}

export function offlineStatus(voice: OfflineVoiceId = 'keqing'): OfflineStatus {
  state = {
    ...state,
    available: offlineNodeBinary() !== null,
    ready: offlineReady(voice),
    bytes: dirBytes(offlineModelDir(voice)),
    dir: offlineModelDir(voice)
  }
  return state
}

/** 流式下载并落盘；拿到 Content-Length 才报百分比，拿不到就只报字节数。 */
async function download(url: string, target: string, onProgress: (ratio: number) => void): Promise<void> {
  const response = await fetch(url)
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
  const total = Number(response.headers.get('content-length') ?? 0)
  const chunks: Uint8Array[] = []
  let received = 0
  for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
    chunks.push(chunk)
    received += chunk.length
    if (total > 0) onProgress(received / total)
  }
  writeFileSync(target, Buffer.concat(chunks.map((c) => Buffer.from(c))))
}

function untar(archive: string, into: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    const child = spawn(tar, ['-xf', archive, '-C', into], { windowsHide: true })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))))
  })
}

/**
 * 下载并解压模型。重复调用会复用同一次下载（`downloading` 期间直接返回现状）。
 * 失败只把错误写进状态，不抛给调用方——朗读功能可以降级，不能因此崩掉主进程。
 */
export async function ensureOfflineModel(voice: OfflineVoiceId = 'keqing'): Promise<OfflineStatus> {
  const files = modelFiles(voice)
  if (offlineReady(voice)) return offlineStatus(voice)
  if (state.downloading) return state
  state = { ...state, downloading: true, error: null, progress: 0 }
  const dir = offlineModelDir()
  const staging = join(dir, '..', `${files.dir}.download`)
  try {
    mkdirSync(staging, { recursive: true })
    const archive = join(staging, 'model.tar.bz2')
    console.log('TTS_OFFLINE_DOWNLOAD_START', JSON.stringify({ url: files.archive }))
    await download(files.archive, archive, (ratio) => {
      state = { ...state, progress: ratio * 0.95 }
    })
    console.log('TTS_OFFLINE_DOWNLOAD_DONE', JSON.stringify({ bytes: statSync(archive).size }))
    await untar(archive, staging)
    const extracted = join(staging, files.dir)
    if (!existsSync(extracted)) throw new Error('archive layout unexpected')
    mkdirSync(join(dir, '..'), { recursive: true })
    // 解压结果复制到正式目录：robocopy 只在目录之间工作，退出码 0–7 都算正常。
    await new Promise<void>((resolve, reject) => {
      const copy = spawn(
        join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'robocopy.exe'),
        [extracted, dir, '/E', '/NFL', '/NDL', '/NJH', '/NJS', '/NC', '/NS'],
        { windowsHide: true }
      )
      copy.on('error', reject)
      copy.on('close', (code) => (code !== null && code <= 7 ? resolve() : reject(new Error('robocopy exit ' + String(code)))))
    })
    state = { ...state, downloading: false, progress: 1, error: null, ready: offlineReady(voice), bytes: dirBytes(dir) }
    console.log('TTS_OFFLINE_READY', JSON.stringify({ dir, bytes: state.bytes }))
    return state
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    state = { ...state, downloading: false, error: message }
    console.log('TTS_OFFLINE_DOWNLOAD_FAILED', JSON.stringify({ err: message }))
    return state
  }
}

/**
 * 推理子进程。Electron 主进程里 sherpa 的原生插件会抛
 * `External buffers are not allowed`（N-API 外部缓冲在 Electron 的 Node 里被禁），
 * 同样的调用在普通 Node 下正常，所以合成搬到 `ELECTRON_RUN_AS_NODE=1` 的子进程里，
 * 引擎只加载一次，后续每句只是一个 JSON 往返 + 一次 WAV 落盘。
 */
let worker: ChildProcess | null = null
let workerSeq = 0
const workerPending = new Map<number, (reply: WorkerReply) => void>()

interface WorkerReply {
  ok: boolean
  err?: string
}

function workerScript(): string {
  // 探针从 out/main/index.js 起，app.getAppPath() 是 out/main，不能直接拼 resources；
  // 打包后则在 resourcesPath 下（electron-builder.yml 的 extraResources 把它摆在那里）。
  const candidates = [
    join(process.resourcesPath ?? '', 'tts-offline-worker.cjs'),
    join(__dirname, '../../resources/tts-offline-worker.cjs'),
    join(app.getAppPath(), 'resources/tts-offline-worker.cjs')
  ]
  const found = candidates.find((candidate) => candidate && existsSync(candidate))
  return found ?? candidates[candidates.length - 1]
}

/**
 * sherpa 的原生插件在**任何** Electron 运行时里都会抛 External buffers are not allowed
 * （试过 1.13.8 与 2.0.0，也试过 ELECTRON_RUN_AS_NODE），只有真正的 node.exe 才正常。
 * 所以先找系统的 node；找不到就老实返回 null，由面板提示改用联网引擎。
 */
let nodeChecked = false
let nodePath: string | null = null

export function offlineNodeBinary(): string | null {
  if (nodeChecked) return nodePath
  nodeChecked = true
  const candidates = [process.env.OHMYDOTA2_NODE, 'node'].filter((value): value is string => Boolean(value))
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['-v'], { encoding: 'utf8', windowsHide: true })
    if (probe.status === 0) {
      nodePath = candidate
      console.log('TTS_OFFLINE_NODE', JSON.stringify({ node: candidate, version: (probe.stdout || '').trim() }))
      return nodePath
    }
  }
  console.log('TTS_OFFLINE_NO_NODE', JSON.stringify({ tried: candidates }))
  return null
}

function ensureWorker(): ChildProcess {
  if (worker && !worker.killed) return worker
  const script = workerScript()
  if (!existsSync(script)) throw new Error(`TTS_OFFLINE_WORKER_MISSING ${script}`)
  const node = offlineNodeBinary()
  if (!node) throw new Error('TTS_OFFLINE_NO_NODE')
  const child = spawn(node, [script], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  })
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
        const reply = JSON.parse(line) as WorkerReply & { id: number }
        const done = workerPending.get(reply.id)
        workerPending.delete(reply.id)
        done?.(reply)
      } catch {
        // 半行或噪声，丢掉。
      }
    }
  })
  child.stderr?.on('data', (chunk: Buffer) => {
    console.log('TTS_OFFLINE_WORKER_STDERR', JSON.stringify({ text: String(chunk).trim().slice(0, 300) }))
  })
  child.on('close', (code) => {
    console.log('TTS_OFFLINE_WORKER_EXIT', JSON.stringify({ code }))
    if (worker === child) worker = null
    for (const done of workerPending.values()) done({ ok: false, err: 'worker exited' })
    workerPending.clear()
  })
  worker = child
  return child
}

/** 合成一句，返回 WAV。模型没装好或推理失败都返回 null（调用方负责「这句不念」）。 */
export async function synthesizeOffline(
  text: string,
  voice: OfflineVoiceId = 'keqing',
  rate = 1
): Promise<Buffer | null> {
  // 预设的语速再乘用户的总语速滑杆：预设定「气质」，滑杆定「快慢」。
  const preset = offlineVoicePreset(voice)
  const speed = preset.speed * rate
  const pitch = preset.pitch
  if (!offlineReady(voice)) return null
  if (!offlineNodeBinary()) return null
  const started = Date.now()
  const out = join(tmpdir(), `oh-my-dota2-tts-${process.pid}-${Date.now()}.wav`)
  try {
    const child = ensureWorker()
    const id = ++workerSeq
    const reply = await new Promise<WorkerReply>((resolve) => {
      const timer = setTimeout(() => {
        workerPending.delete(id)
        resolve({ ok: false, err: 'timeout' })
      }, 10_000)
      workerPending.set(id, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
      child.stdin?.write(`${JSON.stringify({ id, text, speed, pitch, sid: preset.sid ?? modelFiles(voice).sid, dir: offlineModelDir(voice), out })}\n`)
    })
    if (!reply.ok) {
      console.log('TTS_OFFLINE_FAILED', JSON.stringify({ ms: Date.now() - started, err: reply.err ?? 'unknown' }))
      return null
    }
    const wav = readFileSync(out)
    console.log('TTS_OFFLINE_OK', JSON.stringify({ ms: Date.now() - started, bytes: wav.length }))
    return wav
  } catch (err) {
    console.log('TTS_OFFLINE_FAILED', JSON.stringify({ ms: Date.now() - started, err: err instanceof Error ? err.message : String(err) }))
    return null
  } finally {
    try {
      if (existsSync(out)) rmSync(out)
    } catch {
      // 临时文件删不掉不影响这次朗读。
    }
  }
}
