import { spawn } from 'node:child_process'
import { app } from 'electron'
import { createWriteStream, existsSync, mkdirSync, renameSync, statSync, unlinkSync } from 'node:fs'
import { statfs } from 'node:fs/promises'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * GPT-SoVITS 引擎包的应用内安装（一键下载 / 手动放置）。
 *
 * 13GB 进不了 git 也进不了安装包，所以像离线模型一样「用时再取」：
 *   - 安装位：`<userData>/gpt-sovits/GPT-SoVITS-v2pro-20250604/`（dev 在项目 data/ 下，
 *     安装版在安装目录旁的 -data/，NSIS 卸载不碰，见 data-dir.ts）；
 *   - 一键下载：魔搭直链 8.2GB，国内直连满速（不走代理）；8GB 不能像离线模型那样堆进内存，
 *     必须边下边写盘（.part 暂存，完成后改名）；
 *   - 手动安装：用户自己把 .7z 放进 `<userData>/gpt-sovits/`，这里检测到就只做解压；
 *   - 解压：跟着安装包走的 7zr.exe（resources/，LGPL），系统装了 7-Zip 也能用。
 * 已存在判断：`runtime/python.exe` + `api_v2.py` 都在才算装好，重复调用直接返回。
 */

const ARCHIVE_NAME = 'GPT-SoVITS-v2pro-20250604.7z'
const DIR_NAME = 'GPT-SoVITS-v2pro-20250604'
const DOWNLOAD_URL = `https://www.modelscope.cn/models/FlowerCry/gpt-sovits-7z-pacakges/resolve/master/${ARCHIVE_NAME}`
/** 低于这个字节数的 .7z 当作没下完的残片（完整包 8.2GB）。 */
const MIN_ARCHIVE_BYTES = 1024 * 1024 * 1024
/** 空间预检用的估算值（实际压缩包 8.2GB / 解压后 13GB，各留一点余量）。 */
const EST_ARCHIVE_BYTES = 8.5 * 1024 * 1024 * 1024
const EXTRACTED_BYTES = 14 * 1024 * 1024 * 1024
const STALL_MS = 60_000

export interface SovitsInstallState {
  phase: 'idle' | 'downloading' | 'extracting' | 'ready' | 'error'
  /** 0–1；解压阶段没有可靠进度，恒 0（面板显示「解压中」即可）。 */
  progress: number
  error: string | null
}

export function sovitsInstallRoot(): string {
  return join(app.getPath('userData'), 'gpt-sovits')
}

/** 引擎包安装后的目录（sovits-server 的自动发现候选之一）。 */
export function sovitsInstallHome(): string {
  return join(sovitsInstallRoot(), DIR_NAME)
}

export function sovitsInstalled(): boolean {
  const home = sovitsInstallHome()
  return existsSync(join(home, 'runtime', 'python.exe')) && existsSync(join(home, 'api_v2.py'))
}

/** 用户手动放进来的完整 .7z（下载残片不算）。 */
function archivePresent(): boolean {
  const archive = join(sovitsInstallRoot(), ARCHIVE_NAME)
  if (!existsSync(archive)) return false
  try {
    return statSync(archive).size >= MIN_ARCHIVE_BYTES
  } catch {
    return false
  }
}

let state: SovitsInstallState = { phase: 'idle', progress: 0, error: null }
let running = false

export function sovitsInstallState(): SovitsInstallState & { installed: boolean; archivePresent: boolean } {
  return { ...state, installed: sovitsInstalled(), archivePresent: archivePresent() }
}

/** 7z 解压器：优先跟安装包走的 7zr.exe，系统 PATH 里的 7z 也认。 */
function sevenZip(): string {
  const candidates = [
    join(process.resourcesPath ?? '', '7zr.exe'),
    join(__dirname, '../../resources/7zr.exe'),
    join(app.getAppPath(), 'resources/7zr.exe')
  ]
  const found = candidates.find((candidate) => candidate && existsSync(candidate))
  // 都没找到就赌系统 PATH 里有（spawn error 会带原因，面板能看到）。
  return found ?? '7zr'
}

/**
 * 磁盘预检：下载 + 解压的峰值占用（残片/已放好的压缩包抵掉一部分）对比剩余空间，
 * 不够就别开下——下到 80% 才报「磁盘已满」是最伤人的失败方式。拿不到空间数据就放行。
 */
async function checkDiskSpace(): Promise<string | null> {
  try {
    const root = sovitsInstallRoot()
    mkdirSync(root, { recursive: true })
    const info = await statfs(root)
    const free = info.bsize * Number(info.bavail)
    const partBytes = existsSync(join(root, `${ARCHIVE_NAME}.part`)) ? statSync(join(root, `${ARCHIVE_NAME}.part`)).size : 0
    const remainingDownload = archivePresent() ? 0 : Math.max(0, EST_ARCHIVE_BYTES - partBytes)
    const need = remainingDownload + EXTRACTED_BYTES
    if (free < need) {
      return `磁盘空间不足：还需约 ${(need / 1073741824).toFixed(1)} GB（下载+解压峰值），${root} 所在盘只剩 ${(free / 1073741824).toFixed(1)} GB`
    }
    return null
  } catch {
    return null
  }
}

/** 解析 content-range「bytes 100-199/1000」；不合法返回 null。 */
function parseContentRange(header: string | null): { start: number; total: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header ?? '')
  if (!match) return null
  return { start: Number(match[1]), total: Number(match[3]) }
}

async function downloadArchive(onProgress: (ratio: number) => void): Promise<void> {
  const archive = join(sovitsInstallRoot(), ARCHIVE_NAME)
  const part = `${archive}.part`
  // 断点续传：.part 在就带着 Range 接着下（魔搭直链支持，实测返回 206），
  // 8GB 断在第 6GB 不用从零再来——用户重按一次安装按钮即可续上。
  const partBytes = existsSync(part) ? statSync(part).size : 0
  const response = await fetch(DOWNLOAD_URL, partBytes > 0 ? { headers: { Range: `bytes=${partBytes}-` } } : undefined)
  if (response.status === 416 && partBytes >= MIN_ARCHIVE_BYTES) {
    // 残片已经比完整包还大：服务端拒续传，但文件本身大概率是齐的，直接收尾。
    renameSync(part, archive)
    return
  }
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
  let total = Number(response.headers.get('content-length') ?? 0)
  let received = 0
  const range = parseContentRange(response.headers.get('content-range'))
  const appendable = response.status === 206 && range !== null && range.start === partBytes
  if (response.status === 206 && range) total = range.total
  if (appendable) {
    received = partBytes
    console.log('TTS_SOVITS_INSTALL_RESUME', JSON.stringify({ fromBytes: partBytes, total }))
  } else if (partBytes > 0) {
    // 服务端没认 Range（200 全量）或起点对不上：从零重下，别在残片上叠加脏数据。
    console.log('TTS_SOVITS_INSTALL_RESTART', JSON.stringify({ partBytes, status: response.status }))
  }
  const source = Readable.fromWeb(response.body as never)
  let reported = 0
  let lastChunkAt = Date.now()
  const stall = setInterval(() => {
    // 大文件直链偶发断流：60 秒没有新字节就掐断流；已落盘的字节留在 .part 里等续传。
    if (Date.now() - lastChunkAt > STALL_MS) source.destroy(new Error(`stall: no bytes for ${STALL_MS / 1000}s`))
  }, 5_000)
  source.on('data', (chunk: Buffer) => {
    received += chunk.length
    lastChunkAt = Date.now()
    if (total > 0) onProgress(received / total)
    if (received - reported >= 500 * 1024 * 1024) {
      reported = received
      console.log('TTS_SOVITS_INSTALL_PROGRESS', JSON.stringify({ gb: (received / 1073741824).toFixed(2), totalGb: (total / 1073741824).toFixed(2) }))
    }
  })
  try {
    await pipeline(source, createWriteStream(part, { flags: appendable ? 'a' : 'w' }))
    if (received < MIN_ARCHIVE_BYTES) throw new Error(`download too small: ${received}`)
    if (total > 0 && received < total) throw new Error(`download incomplete: ${received}/${total}`)
    renameSync(part, archive)
  } finally {
    clearInterval(stall)
  }
}

function extractArchive(): Promise<void> {
  return new Promise((resolve, reject) => {
    const exe = sevenZip()
    const child = spawn(exe, ['x', `-o${sovitsInstallRoot()}`, '-y', join(sovitsInstallRoot(), ARCHIVE_NAME)], {
      windowsHide: true,
      stdio: 'ignore'
    })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`7zr exit ${code}`))))
  })
}

/** 入口：已装好 → ready；.7z 在 → 只解压；都没有 → 下载再解压。重复调用复用同一轮。 */
export async function ensureSovitsInstall(): Promise<SovitsInstallState> {
  if (sovitsInstalled()) {
    state = { phase: 'ready', progress: 1, error: null }
    return state
  }
  if (running) return state
  running = true
  state = { phase: archivePresent() ? 'extracting' : 'downloading', progress: 0, error: null }
  try {
    mkdirSync(sovitsInstallRoot(), { recursive: true })
    if (!archivePresent()) {
      const shortage = await checkDiskSpace()
      if (shortage) throw new Error(shortage)
      console.log('TTS_SOVITS_INSTALL_DOWNLOAD', JSON.stringify({ url: DOWNLOAD_URL }))
      await downloadArchive((ratio) => {
        state = { ...state, progress: ratio }
      })
    }
    state = { phase: 'extracting', progress: 0, error: null }
    console.log('TTS_SOVITS_INSTALL_EXTRACT', JSON.stringify({ archive: join(sovitsInstallRoot(), ARCHIVE_NAME) }))
    await extractArchive()
    if (!sovitsInstalled()) throw new Error('archive layout unexpected')
    try {
      unlinkSync(join(sovitsInstallRoot(), ARCHIVE_NAME))
    } catch {
      // 解压完的压缩包删不掉不碍事，用户可手删。
    }
    state = { phase: 'ready', progress: 1, error: null }
    console.log('TTS_SOVITS_INSTALL_READY', JSON.stringify({ home: sovitsInstallHome() }))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    state = { phase: 'error', progress: 0, error: message }
    console.log('TTS_SOVITS_INSTALL_FAILED', JSON.stringify({ err: message }))
  } finally {
    running = false
  }
  return state
}
