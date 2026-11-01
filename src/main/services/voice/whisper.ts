import { app, net } from 'electron'
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { VoiceBackendStatus, VoiceAssetsResult, VoiceProbeResult, VoiceTranscribeResult } from '@shared/ipc'

const PROBE_TIMEOUT_MS = 8000
const RELEASE_TAG = 'b5454'
const BIN_URL = `https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE_TAG}/whisper-bin-x64.zip`
// small 档对带口音的中文明显更稳（base 在重口音下丢字、串英文）；CPU 6 线程短句仍在数秒级。
const MODEL_URLS = [
  'https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin',
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-small.bin'
]
const MODEL_NAME = 'ggml-small.bin'
const PARALLEL_PARTS = 16

function run(
  bin: string,
  args: string[],
  timeoutMs: number
): Promise<{ ok: boolean; output: string; error?: string }> {
  return new Promise((resolve) => {
    let settled = false
    let output = ''
    const finish = (result: { ok: boolean; output: string; error?: string }): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const child = spawn(bin, args, { windowsHide: true })
    const timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, output, error: `timed out after ${timeoutMs}ms` })
    }, timeoutMs)
    child.stdout.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.stderr.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf8')
    })
    child.on('error', (err) => finish({ ok: false, output, error: err.message }))
    child.on('close', (code) =>
      finish(
        code === 0
          ? { ok: true, output }
          : {
              ok: false,
              output,
              // 把子进程自己的 stderr 尾巴带上，面板才能看到「为什么」而不是光秃秃的 exit code。
              error: `exit code ${code ?? 'null'}: ${output.slice(-240).trim() || '(无输出)'}`
            }
      )
    )
  })
}

/** whisper-cli emits markers such as [BLANK_AUDIO] for silence-only clips. */
function stripBlankMarkers(text: string): string {
  return text
    .replace(/\[[^\]]*BLANK[^\]]*\]/gi, '')
    .replace(/\[[^\]]*(SILENCE|NOISE|MUSIC)[^\]]*\]/gi, '')
    .replace(/^\([^)]*\)$/g, '')
    .trim()
}

function whisperRoot(): string {
  return join(app.getPath('userData'), 'whisper')
}

function binDir(): string {
  return join(whisperRoot(), 'bin')
}

function modelDir(): string {
  return join(whisperRoot(), 'models')
}

/** Locate whisper-cli.exe (b5454) or the older main.exe inside the extracted bin dir. */
function findBinary(dir: string): string | null {
  if (!existsSync(dir)) return null
  const entries = readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const nested = findBinary(full)
      if (nested) return nested
      continue
    }
    if (entry.name.toLowerCase() === 'whisper-cli.exe') return full
  }
  // 新版 whisper.cpp 已把 main.exe 换成「只打印弃用警告」的空壳（27KB），跑了必 exit 1；
  // 小于 1MB 一律当空壳跳过，逼 ensureAssets 重新下载带 whisper-cli.exe 的正式包。
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isFile() && entry.name.toLowerCase() === 'main.exe' && statSync(full).size >= 1024 * 1024) {
      return full
    }
  }
  return null
}

/** Write a response body to disk while reporting byte progress. */
async function writeResponse(
  response: Response,
  dest: string,
  onBytes: (bytes: number) => void
): Promise<void> {
  const sink = createWriteStream(dest)
  try {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      const buffer = Buffer.from(chunk)
      onBytes(buffer.length)
      if (!sink.write(buffer)) await new Promise<void>((resolve) => sink.once('drain', () => resolve()))
    }
    await new Promise<void>((resolve, reject) => {
      sink.end((err?: Error | null) => (err ? reject(err) : resolve()))
    })
  } catch (err) {
    sink.destroy()
    throw err
  }
}

/**
 * GitHub releases are not reachable from CN without the proxy, so small files go
 * through Electron's net (session proxy) in a single stream.
 */
async function downloadViaProxy(url: string, dest: string, onPct?: (pct: number) => void): Promise<void> {
  const response = await net.fetch(url, { bypassCustomProtocolHandlers: true })
  if (!response.ok || !response.body) throw new Error(`http ${response.status}`)
  const total = Number(response.headers.get('content-length') ?? 0)
  let received = 0
  await writeResponse(response, dest, (bytes) => {
    received += bytes
    if (total > 0) onPct?.(Math.round((received / total) * 100))
  })
}

/**
 * HF mirrors throttle each connection to ~40 KB/s, so the model is fetched as
 * parallel byte ranges (aggregate throughput ~2 MB/s) and concatenated.
 */
async function downloadParallel(
  url: string,
  dest: string,
  onPct?: (pct: number) => void
): Promise<void> {
  const head = await fetch(url, { headers: { Range: 'bytes=0-0' } })
  if (!head.ok) throw new Error(`http ${head.status}`)
  const range = head.headers.get('content-range') ?? ''
  const size = Number(range.split('/')[1] ?? 0)
  await head.body?.cancel()
  if (!Number.isFinite(size) || size < 1024) throw new Error('unknown content length')

  const chunk = Math.ceil(size / PARALLEL_PARTS)
  const parts: string[] = []
  for (let index = 0; index < PARALLEL_PARTS; index += 1) {
    rmSync(`${dest}.part${index}`, { force: true })
  }
  let received = 0
  await Promise.all(
    Array.from({ length: PARALLEL_PARTS }, async (_value, index) => {
      const start = index * chunk
      const end = Math.min(size - 1, start + chunk - 1)
      if (start > end) return
      const response = await fetch(url, { headers: { Range: `bytes=${start}-${end}` } })
      if (!response.ok || !response.body) throw new Error(`range ${index} http ${response.status}`)
      const partPath = `${dest}.part${index}`
      parts[index] = partPath
      await writeResponse(response, partPath, (bytes) => {
        received += bytes
        onPct?.(Math.round((received / size) * 100))
      })
    })
  )

  const sink = createWriteStream(dest)
  try {
    for (const partPath of parts) {
      const buffer = readFileSync(partPath)
      rmSync(partPath, { force: true })
      if (!sink.write(buffer)) await new Promise<void>((resolve) => sink.once('drain', () => resolve()))
    }
    await new Promise<void>((resolve, reject) => {
      sink.end((err?: Error | null) => (err ? reject(err) : resolve()))
    })
  } catch (err) {
    sink.destroy()
    throw err
  }
}

async function downloadModel(dest: string, onPct?: (pct: number) => void): Promise<void> {
  let lastError = ''
  for (const url of MODEL_URLS) {
    try {
      await downloadParallel(url, dest, onPct)
      return
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
    }
  }
  throw new Error(lastError || '模型下载失败')
}

function extractZipSync(zipPath: string, outDir: string): Promise<{ ok: boolean; error?: string }> {
  return new Promise((resolve) => {
    const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    let stderr = ''
    const child = spawn(tar, ['-xf', zipPath, '-C', outDir], { windowsHide: true })
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8')
    })
    child.on('error', (err) => resolve({ ok: false, error: err.message }))
    child.on('close', (code) =>
      resolve(code === 0 ? { ok: true } : { ok: false, error: stderr.trim() || `tar exit ${code}` })
    )
  })
}

/**
 * whisper.cpp adapter: downloads the prebuilt Windows CPU binary and a base model,
 * then transcribes 16 kHz mono WAV files produced by the microphone pipeline.
 */
class WhisperAdapter {
  status(binPath: string): VoiceBackendStatus {
    const path = binPath.trim() || (findBinary(binDir()) ?? '')
    return { configured: path.length > 0, path, exists: path.length > 0 && existsSync(path) }
  }

  modelPath(): string {
    return join(modelDir(), MODEL_NAME)
  }

  /** Download binary + model into userData/whisper when missing. */
  async ensureAssets(onProgress?: (phase: string, pct: number) => void): Promise<VoiceAssetsResult> {
    mkdirSync(binDir(), { recursive: true })
    mkdirSync(modelDir(), { recursive: true })
    let downloadedBin = false
    let downloadedModel = false

    let binary = findBinary(binDir())
    if (!binary) {
      const zipPath = join(whisperRoot(), 'whisper-bin-x64.zip')
      onProgress?.('binary', 0)
      try {
        await downloadViaProxy(BIN_URL, zipPath, (pct) => onProgress?.('binary', pct))
      } catch (err) {
        return { ok: false, binaryPath: null, modelPath: null, error: `binary download failed: ${String(err)}` }
      }
      const extract = await extractZipSync(zipPath, binDir())
      rmSync(zipPath, { force: true })
      if (!extract.ok) return { ok: false, binaryPath: null, modelPath: null, error: `unzip failed: ${extract.error}` }
      binary = findBinary(binDir())
      if (!binary) return { ok: false, binaryPath: null, modelPath: null, error: '解压后没有找到 whisper-cli.exe' }
      downloadedBin = true
    }

    const model = this.modelPath()
    if (!existsSync(model) || statSync(model).size < 1024 * 1024) {
      onProgress?.('model', 0)
      try {
        await downloadModel(model, (pct) => onProgress?.('model', pct))
      } catch (err) {
        return {
          ok: false,
          binaryPath: binary,
          modelPath: null,
          error: `model download failed: ${err instanceof Error ? err.message : String(err)}`
        }
      }
      downloadedModel = true
    }

    return { ok: true, binaryPath: binary, modelPath: model, downloadedBin, downloadedModel }
  }

  async probe(binPath: string): Promise<VoiceProbeResult> {
    const path = binPath.trim() || (findBinary(binDir()) ?? '')
    if (!path) return { ok: false, configured: false, error: '还没有设置 whisper.cpp 路径' }
    if (!existsSync(path)) {
      return { ok: false, configured: true, error: `binary not found: ${path}` }
    }
    const result = await run(path, ['--help'], PROBE_TIMEOUT_MS)
    const banner =
      result.output
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find((line) => line.length > 0) ?? ''
    if (!result.ok && !banner.includes('whisper')) {
      return { ok: false, configured: true, error: result.error ?? '探测失败', detail: banner }
    }
    // 弃用空壳也会打印带 whisper 字样的横幅，但它是干不了活的——单独立一道闸。
    if (/deprecated/i.test(banner)) {
      return {
        ok: false,
        configured: true,
        error: '这个 main.exe 是弃用空壳，转写必然失败；重新下载 whisper 资源换 whisper-cli.exe',
        detail: banner.slice(0, 160)
      }
    }
    return {
      ok: true,
      configured: true,
      detail: banner.slice(0, 160),
      note: existsSync(this.modelPath()) ? 'model ready' : 'model not downloaded yet'
    }
  }

  /**
   * Transcribe a 16 kHz mono WAV file with whisper-cli.
   * 语言默认钉死中文：对讲链路进来就是中文；auto 在短句+口音下容易误判语种或串英文。
   */
  async transcribe(wavPath: string, language = 'zh'): Promise<VoiceTranscribeResult> {
    const assets = await this.ensureAssets()
    if (!assets.ok || !assets.binaryPath || !assets.modelPath) {
      return { ok: false, text: '', error: assets.error ?? 'whisper 资源不可用' }
    }
    if (!existsSync(wavPath)) return { ok: false, text: '', error: `wav not found: ${wavPath}` }
    const outBase = wavPath.replace(/\.wav$/i, '')
    const result = await run(
      assets.binaryPath,
      [
        '--model',
        assets.modelPath,
        '--file',
        wavPath,
        '--language',
        language,
        // 简体中文偏置：不加这句 whisper 会偏繁体输出；代价是标点会少，对翻译链路无碍。
        '--prompt',
        '以下是普通话的句子。',
        '--no-timestamps',
        '--output-txt',
        '--output-file',
        outBase,
        '--threads',
        '6'
      ],
      180_000
    )
    const txtPath = `${outBase}.txt`
    const text = existsSync(txtPath) ? readFileSync(txtPath, 'utf8').trim() : ''
    if (!result.ok) return { ok: false, text, error: result.error ?? '转写失败' }
    return { ok: true, text: stripBlankMarkers(text) }
  }
}

let adapter: WhisperAdapter | null = null

export function getWhisperAdapter(): WhisperAdapter {
  if (!adapter) adapter = new WhisperAdapter()
  return adapter
}
