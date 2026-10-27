import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { app } from 'electron'
import type { OfflineStatus } from '../../../shared/ipc'
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { offlineVoicePreset, type OfflineVoiceId } from '../../../shared/ipc'

/**
 * 离线朗读引擎：sherpa-onnx 本地 TTS（matcha/vits 三款模型，见 MODEL_FILES）。
 *
 * 为什么不是 Edge：Edge 每句都要一次跨境往返（实测 700–1639 ms）；离线模型在本机 0.1–0.4 s，
 * 22.05 kHz。选型实测见 docs/BENCH.md：MeloTTS 音色最正但延迟最高（~0.5 s，2026-10-25 移除），
 * vits-zh-aishell3 有 174 个说话人但采样率只有 8 kHz（电话音质），Kokoro int8 最慢。
 *
 * 模型不进安装包：单个模型上百 MB，会推翻 93 MB 的安装包体积。
 * 首次选用离线引擎时才下载到 `data/tts-models/`，解压用系统自带的 tar.exe（Win10+ 是 bsdtar，
 * 认 bz2），不额外引入解压依赖。
 */

interface ModelFiles {
  /** 解压后的目录名（也是 tts-models 下的子目录名）。 */
  dir: string
  /** 要下载的压缩包；matcha 还要单独下一个声码器，所以这里是数组。 */
  archives: string[]
  /** vits = 单 onnx；matcha = 声学模型 + 声码器，字段名不一样，worker 里分支处理。 */
  kind: 'vits' | 'matcha'
  /** 注册表直接给出 onnx 文件名——让 worker 猜过两次，都是猜错才发现的。 */
  model: string
  required: string[]
  /** 这个包自带 dict（中文分词/多音字）才去查它，piper 的包就没有。 */
  dict: boolean
  /** 声码器文件名（只需要下一个，放在 tts-models 根目录共用）。 */
  vocoder?: string
  /** 多说话人模型固定用哪一个嗓子；单说话人模型恒为 0。 */
  sid: number
}

const TTS_MODELS = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models'
const VOCODERS = 'https://github.com/k2-fsa/sherpa-onnx/releases/download/vocoder-models'

const MODEL_FILES: Record<OfflineVoiceId, ModelFiles> = {
  baker: {
    dir: 'matcha-icefall-zh-baker',
    archives: [`${TTS_MODELS}/matcha-icefall-zh-baker.tar.bz2`],
    kind: 'matcha',
    model: 'model-steps-3.onnx',
    required: ['model-steps-3.onnx', 'tokens.txt', 'lexicon.txt'],
    dict: true,
    vocoder: 'vocos-22khz-univ.onnx',
    sid: 0
  },
  xiao_ya: {
    dir: 'vits-piper-zh_CN-xiao_ya-medium',
    archives: [`${TTS_MODELS}/vits-piper-zh_CN-xiao_ya-medium.tar.bz2`],
    kind: 'vits',
    model: 'zh_CN-xiao_ya-medium.onnx',
    required: ['zh_CN-xiao_ya-medium.onnx', 'tokens.txt', 'lexicon.txt'],
    dict: false,
    sid: 0
  },
  eula: {
    dir: 'vits-zh-hf-eula',
    archives: [`${TTS_MODELS}/vits-zh-hf-eula.tar.bz2`],
    kind: 'vits',
    model: 'eula.onnx',
    required: ['eula.onnx', 'tokens.txt', 'lexicon.txt'],
    dict: true,
    sid: 5
  }
}

function modelFiles(voice: OfflineVoiceId): ModelFiles {
  return MODEL_FILES[voice] ?? MODEL_FILES.baker
}

export function offlineModelDir(voice: OfflineVoiceId = 'baker'): string {
  return join(app.getPath('userData'), 'tts-models', modelFiles(voice).dir)
}

function vocoderFile(name: string): string {
  return join(app.getPath('userData'), 'tts-models', name)
}

/** 声码器的绝对路径；vits 模型没有声码器就返回 undefined（worker 只看 matcha 那支）。 */
function vocoderPath(voice: OfflineVoiceId): string | undefined {
  const name = modelFiles(voice).vocoder
  return name ? vocoderFile(name) : undefined
}

export function offlineReady(voice: OfflineVoiceId = 'baker'): boolean {
  const files = modelFiles(voice)
  const dir = offlineModelDir(voice)
  if (!files.required.every((name) => existsSync(join(dir, name)))) return false
  if (files.dict && !existsSync(join(dir, 'dict'))) return false
  if (files.vocoder && !existsSync(vocoderFile(files.vocoder))) return false
  return true
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

export function offlineStatus(voice: OfflineVoiceId = 'baker'): OfflineStatus {
  state = {
    ...state,
    available: offlineNodeBinary() !== null,
    ready: offlineReady(voice),
    bytes: dirBytes(offlineModelDir(voice)),
    dir: offlineModelDir(voice)
  }
  return state
}

/**
 * GitHub release 在国内经常「连得上、没有字节」——fetch 会一直挂着不报错，
 * 界面就一直停在 0%，看起来像点了没反应。所以这里做三件事：
 *   1. 每个镜像都有停滞超时：15 秒没有新数据就判死，换下一个源；
 *   2. 依次尝试直连与几个已知的 GitHub 加速前缀；
 *   3. 每 2 MB 打一行日志，下载卡在哪一目了然。
 */
const MIRRORS = ['', 'https://gh-proxy.com/', 'https://ghfast.top/']
const STALL_MS = 15_000

async function downloadOnce(url: string, target: string, onProgress: (ratio: number) => void): Promise<void> {
  const controller = new AbortController()
  let stall = setTimeout(() => controller.abort(), STALL_MS)
  const started = Date.now()
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
    const total = Number(response.headers.get('content-length') ?? 0)
    const chunks: Uint8Array[] = []
    let received = 0
    let reported = 0
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      chunks.push(chunk)
      received += chunk.length
      clearTimeout(stall)
      stall = setTimeout(() => controller.abort(), STALL_MS)
      if (total > 0) onProgress(received / total)
      if (received - reported >= 2 * 1024 * 1024) {
        reported = received
        console.log(
          'TTS_OFFLINE_DOWNLOAD_PROGRESS',
          JSON.stringify({ mb: Math.round(received / 1024 / 1024), totalMb: Math.round(total / 1024 / 1024) })
        )
      }
    }
    if (received === 0) throw new Error('no bytes')
    writeFileSync(target, Buffer.concat(chunks.map((c) => Buffer.from(c))))
    console.log(
      'TTS_OFFLINE_DOWNLOAD_DONE',
      JSON.stringify({ bytes: received, ms: Date.now() - started })
    )
  } finally {
    clearTimeout(stall)
  }
}

/** 依次试直连与镜像；全失败时抛出最后一个原因。 */
async function download(url: string, target: string, onProgress: (ratio: number) => void): Promise<void> {
  let lastError = 'unknown'
  for (const prefix of MIRRORS) {
    const candidate = prefix === '' ? url : `${prefix}${url}`
    try {
      console.log('TTS_OFFLINE_DOWNLOAD_TRY', JSON.stringify({ url: candidate }))
      await downloadOnce(candidate, target, onProgress)
      if (prefix !== '') console.log('TTS_OFFLINE_DOWNLOAD_MIRROR', JSON.stringify({ prefix }))
      return
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      console.log('TTS_OFFLINE_DOWNLOAD_RETRY', JSON.stringify({ url: candidate, err: lastError }))
    }
  }
  throw new Error(`下载失败：${lastError}`)
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
export async function ensureOfflineModel(voice: OfflineVoiceId = 'baker'): Promise<OfflineStatus> {
  const files = modelFiles(voice)
  if (offlineReady(voice)) return offlineStatus(voice)
  if (state.downloading) return state
  state = { ...state, downloading: true, error: null, progress: 0 }
  const dir = offlineModelDir()
  const staging = join(dir, '..', `${files.dir}.download`)
  try {
    mkdirSync(staging, { recursive: true })
    const archive = join(staging, 'model.tar.bz2')
    console.log('TTS_OFFLINE_DOWNLOAD_START', JSON.stringify({ url: files.archives[0], mirrors: MIRRORS.length - 1 }))
    await download(files.archives[0], archive, (ratio) => {
      state = { ...state, progress: ratio * 0.9 }
    })
    console.log('TTS_OFFLINE_DOWNLOAD_SAVED', JSON.stringify({ bytes: statSync(archive).size }))
    await untar(archive, staging)
    const extracted = join(staging, files.dir)
    if (!existsSync(extracted)) throw new Error('archive layout unexpected')
    // matcha 的声码器是独立文件，官方单独发在 vocoder-models 下。
    if (files.vocoder && !existsSync(vocoderFile(files.vocoder))) {
      const target = vocoderFile(files.vocoder)
      mkdirSync(join(target, '..'), { recursive: true })
      await download(`${VOCODERS}/${files.vocoder}`, target, (ratio) => {
        state = { ...state, progress: 0.9 + ratio * 0.05 }
      })
      console.log('TTS_OFFLINE_VOCODER_SAVED', JSON.stringify({ file: target, bytes: statSync(target).size }))
    }
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
  voice: OfflineVoiceId = 'baker',
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
      child.stdin?.write(
        `${JSON.stringify({
          id,
          text,
          speed,
          pitch,
          sid: preset.sid ?? modelFiles(voice).sid,
          dir: offlineModelDir(voice),
          // onnx 文件名与架构都由注册表给出：猜错就是 'vits-model ... does not exist'，
          // 或者 matcha 包被当成 vits 加载直接报 config 错。
          kind: modelFiles(voice).kind,
          model: modelFiles(voice).model,
          vocoder: vocoderPath(voice),
          out
        })}\n`
      )
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
