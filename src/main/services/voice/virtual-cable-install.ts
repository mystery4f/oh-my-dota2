import { spawn } from 'node:child_process'
import { app, net } from 'electron'
import { errorMessage } from '@shared/errors'
import type { CableInstallResult } from '@shared/voice-out'
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * VB-Cable 的一键安装：下载官方包 → 解压 → 提权启动官方安装器。
 *
 * 边界（许可 + 驱动机制决定，不要越过）：
 *   - VB-Cable 的 readme 允许原样转发，但禁止并入别的软件的安装流程，
 *     所以我们只搬运官方包并拉起官方安装器，不改包、不静默注入驱动；
 *   - 安装必须管理员权限，UAC 与「重启电脑」都只能用户自己点，一步都省不掉；
 *   - 下载源在墙外：先直连，失败再用 Chromium 网络栈（自动跟随系统代理）重试。
 */

const PAGE_URL = 'https://vb-audio.com/Cable/'
/** 页面解析失败时的兜底版本；数字越大越新，页面能读就以页面为准。 */
const FALLBACK_PACK_URL = 'https://download.vb-audio.com/Download_CABLE/VBCABLE_Driver_Pack46.zip'
/** 完整包约 1.3 MB；小于这个数当作残片，不能拿去解压。 */
const MIN_PACK_BYTES = 512 * 1024
const EXE_NAME = 'VBCABLE_Setup_x64.exe'

/** 从官方页挑最新版本的包地址；页面结构变了就返回 null，调用方用兜底常量。 */
export function pickCablePackUrl(html: string): string | null {
  let best: { version: number; url: string } | null = null
  const pattern = /https:\/\/download\.vb-audio\.com\/Download_CABLE\/VBCABLE_Driver_Pack(\d+)\.zip/gi
  for (const match of html.matchAll(pattern)) {
    const version = Number(match[1])
    if (!best || version > best.version) best = { version, url: match[0] }
  }
  return best?.url ?? null
}

function packDir(): string {
  return join(app.getPath('userData'), 'vb-cable')
}

function assertPackSize(path: string): void {
  const size = statSync(path).size
  if (size < MIN_PACK_BYTES) throw new Error(`下载不完整（${size} 字节）`)
}

/** 直连下载：国内常被掐，失败交给 chromium 那一腿。 */
async function downloadDirect(url: string, dest: string): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(20_000) })
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  writeFileSync(dest, Buffer.from(await response.arrayBuffer()))
  assertPackSize(dest)
}

/** 走 Chromium 网络栈（默认 session 跟随系统代理）；1.3 MB 直接进内存。 */
function downloadViaChromium(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = net.request({ url, redirect: 'follow' })
    request.on('error', reject)
    request.on('response', (response) => {
      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`))
        return
      }
      const chunks: Buffer[] = []
      response.on('error', reject)
      response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
      response.on('end', () => {
        try {
          writeFileSync(dest, Buffer.concat(chunks))
          assertPackSize(dest)
          resolve()
        } catch (err) {
          reject(err)
        }
      })
    })
    request.end()
  })
}

async function downloadPack(url: string, dest: string): Promise<void> {
  try {
    await downloadDirect(url, dest)
  } catch (directError) {
    console.log('VCABLE_INSTALL_DIRECT_FAILED', JSON.stringify({ err: errorMessage(directError) }))
    rmSync(dest, { force: true })
    await downloadViaChromium(url, dest)
  }
}

async function resolvePackUrl(): Promise<string> {
  try {
    const response = await fetch(PAGE_URL, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const picked = pickCablePackUrl(await response.text())
    if (picked) return picked
    throw new Error('页面上没找到下载链接')
  } catch (err) {
    console.log('VCABLE_INSTALL_PAGE_FAILED', JSON.stringify({ err: errorMessage(err), fallback: FALLBACK_PACK_URL }))
    return FALLBACK_PACK_URL
  }
}

/** 用系统自带的 bsdtar 解压（Git Bash 的 GNU tar 读不了 zip）。 */
function extractPack(zip: string, dir: string): Promise<void> {
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  if (!existsSync(tar)) return Promise.reject(new Error('系统里找不到 tar.exe'))
  return new Promise((resolve, reject) => {
    const child = spawn(tar, ['-xf', zip, '-C', dir], { windowsHide: true, stdio: 'ignore' })
    child.on('error', reject)
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`tar exit ${code}`))))
  })
}

/** 提权启动官方安装器：UAC 弹窗由系统接管，用户点「是」之后向导才开始。 */
function launchElevated(exe: string, dir: string): Promise<void> {
  const quote = (value: string): string => `'${value.replace(/'/g, "''")}'`
  const script = `Start-Process -FilePath ${quote(exe)} -WorkingDirectory ${quote(dir)} -Verb RunAs -ErrorAction Stop`
  return new Promise((resolve, reject) => {
    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { windowsHide: true }
    )
    let stderr = ''
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(stderr.trim() || `提权没成功（exit ${code}）`))
    )
  })
}

let running: Promise<CableInstallResult> | null = null

/** 入口：包不在就下，然后提权启动；重复点击复用同一轮。 */
export function installVirtualCable(): Promise<CableInstallResult> {
  running ??= runInstall().finally(() => {
    running = null
  })
  return running
}

async function runInstall(): Promise<CableInstallResult> {
  const dir = packDir()
  const exe = join(dir, EXE_NAME)
  try {
    mkdirSync(dir, { recursive: true })
    if (!existsSync(exe)) {
      const url = await resolvePackUrl()
      const zip = join(dir, 'vb-cable.zip')
      console.log('VCABLE_INSTALL_DOWNLOAD', JSON.stringify({ url, dir }))
      await downloadPack(url, zip)
      console.log('VCABLE_INSTALL_EXTRACT', JSON.stringify({ zip }))
      await extractPack(zip, dir)
      rmSync(zip, { force: true })
    }
    if (!existsSync(exe)) throw new Error(`解压后没找到 ${EXE_NAME}`)
    console.log('VCABLE_INSTALL_LAUNCH', JSON.stringify({ exe }))
    await launchElevated(exe, dir)
    return { ok: true, launched: true, dir, error: null }
  } catch (err) {
    const message = errorMessage(err)
    console.log('VCABLE_INSTALL_FAILED', JSON.stringify({ err: message, dir }))
    return { ok: false, launched: false, dir, error: message }
  }
}
