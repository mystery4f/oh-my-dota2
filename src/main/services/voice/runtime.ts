import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { app } from 'electron'
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from 'node:fs'
import { basename, dirname, join } from 'node:path'
import {
  NODE_RUNTIME_ZIP,
  SHERPA_PACKAGES,
  VOICE_RUNTIME_DIR_NAME,
  VOICE_RUNTIME_NODE_MODULES,
  VOICE_RUNTIME_RUNTIME_JSON,
  joinNodePath,
  nodeCandidates,
  parseRuntimeJson,
  runtimeStateFromDisk,
  type VoiceRuntimeJson,
  type VoiceRuntimeState
} from '@shared/voice-runtime'
import { downloadResumable } from '../net/download'
import { createInstallJob } from '../install-job'

/**
 * 语音运行时的副作用：装 node.exe、拷 sherpa 插件、按文件下 Qwen3 模型。
 * 规则（目录名、清单、哈希、候选顺序）全部在 @shared/voice-runtime，这里只碰磁盘与网络。
 *
 * 为什么 node 要应用自己装：sherpa 原生插件在 Electron 里抛 External buffers
 * are not allowed，必须真 node.exe；安装版机器上通常没有，而 sherpa 包又只在
 * 应用的 node_modules 里——所以「应用包内找插件 + 自带 node」两条腿一起补（#45）。
 */

export function voiceRuntimeDir(): string {
  return join(app.getPath('userData'), VOICE_RUNTIME_DIR_NAME)
}

export function voiceRuntimeNode(): string {
  return join(voiceRuntimeDir(), 'node.exe')
}

export function voiceRuntimeNodeModules(): string {
  return join(voiceRuntimeDir(), VOICE_RUNTIME_NODE_MODULES)
}

/** 应用自带 sherpa 插件的候选根：安装版在 app.asar.unpacked 旁边，开发机在项目 node_modules。 */
function sherpaSourceRoots(): string[] {
  const appPath = app.getAppPath()
  const packagedRoot = appPath.replace(/app\.asar$/, 'app.asar.unpacked')
  return [join(packagedRoot, 'node_modules'), join(appPath, 'node_modules')]
}

/** 每个包在源里是否存在（存在 = 目录 + package.json，半截拷贝不算）。 */
export function sherpaPackageSources(): Record<string, string | null> {
  const found: Record<string, string | null> = {}
  for (const name of SHERPA_PACKAGES) {
    found[name] = null
    for (const root of sherpaSourceRoots()) {
      const candidate = join(root, name)
      if (existsSync(join(candidate, 'package.json'))) {
        found[name] = candidate
        break
      }
    }
  }
  return found
}

function readRuntimeJson(): VoiceRuntimeJson | null {
  try {
    return parseRuntimeJson(readFileSync(join(voiceRuntimeDir(), VOICE_RUNTIME_RUNTIME_JSON), 'utf8'))
  } catch {
    return null
  }
}

export function voiceRuntimeState(): VoiceRuntimeState {
  const packages: Record<string, boolean> = {}
  for (const name of SHERPA_PACKAGES) packages[name] = existsSync(join(voiceRuntimeNodeModules(), name, 'package.json'))
  return runtimeStateFromDisk({ nodeExists: existsSync(voiceRuntimeNode()), packagesPresent: packages, json: readRuntimeJson() })
}

let nodeChecked = false
let nodePath: string | null = null

/** 识别与离线朗读共用的 node 解析：运行时优先，其次环境变量，最后 PATH；带缓存。 */
export function voiceRuntimeNodeBinary(): string | null {
  if (nodeChecked) return nodePath
  nodeChecked = true
  for (const candidate of nodeCandidates(voiceRuntimeNode())) {
    const probe = spawnSync(candidate, ['-v'], { encoding: 'utf8', windowsHide: true })
    if (probe.status === 0) {
      nodePath = candidate
      return nodePath
    }
  }
  console.log('VOICE_RUNTIME_NO_NODE', JSON.stringify({ tried: nodeCandidates(voiceRuntimeNode()) }))
  return null
}

/** 装好运行时后让缓存失效：下一次 spawn 立刻看到新 node。 */
export function resetNodeProbe(): void {
  nodeChecked = false
  nodePath = null
}

/** worker 子进程环境：NODE_PATH 前置运行时的 node_modules（require 先看运行时插件）。 */
export function voiceWorkerEnv(): NodeJS.ProcessEnv {
  return { ...process.env, NODE_PATH: joinNodePath(voiceRuntimeNodeModules(), process.env.NODE_PATH) }
}

export interface VoiceRuntimeProgress {
  stage: 'packages' | 'node-download' | 'node-verify' | 'node-extract' | 'done'
  /** 0–1；下载阶段按字节，其余按阶段粒度。 */
  progress: number
  detail?: string
}

export type VoiceRuntimeProgressListener = (progress: VoiceRuntimeProgress) => void

let installListeners: VoiceRuntimeProgressListener[] = []

/** 面板订阅安装进度（广播通道由 ipc.ts 接线）。 */
export function onVoiceRuntimeProgress(listener: VoiceRuntimeProgressListener): () => void {
  installListeners.push(listener)
  return () => {
    installListeners = installListeners.filter((entry) => entry !== listener)
  }
}

function emit(progress: VoiceRuntimeProgress): void {
  for (const listener of installListeners) listener(progress)
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

const runtimeInstallJob = createInstallJob()
let installError: string | null = null

export function voiceRuntimeInstallState(): { installing: boolean; installError: string | null } {
  return { installing: runtimeInstallJob.running(), installError }
}

/**
 * 一键安装：从应用包拷 sherpa 插件 → 下载 node.exe 压缩包（断点续传）→ 校验 → 解压 → 写 runtime.json。
 * 失败保留现场可重试；重装整体覆盖（插件 cpSync 幂等，node.exe 原子改名）。
 */
export async function installVoiceRuntime(): Promise<{ ok: boolean; error: string | null }> {
  const result = await runtimeInstallJob.run({
    busyError: '正在安装，等这一轮结束再点',
    onStart: () => {
      installError = null
    },
    onProgress: (progress, stage) => emit({ stage: (stage ?? 'packages') as VoiceRuntimeProgress['stage'], progress }),
    onSettled: (ok, error) => {
      installError = ok ? null : error
      if (!ok) console.log('VOICE_RUNTIME_INSTALL_FAILED', JSON.stringify({ err: error }))
    },
    work: async (report) => {
      mkdirSync(voiceRuntimeDir(), { recursive: true })
      report(0.05, 'packages')
      const sources = sherpaPackageSources()
      const missingPackages = SHERPA_PACKAGES.filter((name) => !sources[name])
      if (missingPackages.length > 0) {
        throw new Error(`应用包里缺 sherpa 插件（${missingPackages.join('、')}）：这个安装包构建坏了，请反馈`)
      }
      mkdirSync(voiceRuntimeNodeModules(), { recursive: true })
      for (const name of SHERPA_PACKAGES) cpSync(sources[name] as string, join(voiceRuntimeNodeModules(), name), { recursive: true })

      const zipDest = join(voiceRuntimeDir(), 'node.zip')
      report(0.1, 'node-download')
      await downloadResumable({
        url: NODE_RUNTIME_ZIP.url,
        dest: zipDest,
        expectedBytes: NODE_RUNTIME_ZIP.bytes,
        stallMs: 30_000,
        onProgress: (done, total) => report(0.1 + 0.55 * (done / Math.max(1, total)), 'node-download'),
        onLog: (tag, detail) => console.log('VOICE_RUNTIME_NODE_DL', JSON.stringify({ tag, ...detail }))
      })
      report(0.7, 'node-verify')
      const actualSha = sha256File(zipDest)
      if (actualSha !== NODE_RUNTIME_ZIP.sha256) {
        rmSync(zipDest, { force: true })
        throw new Error(`node.zip 哈希不符（${actualSha.slice(0, 12)}…），已删除，可重试`)
      }

      report(0.8, 'node-extract')
      // 7zr 只认 .7z（喂 zip 直接退出码 2）；Windows 自带的 bsdtar 原生读 zip，
      // --include 按路径过滤，只解 node.exe 这一个文件，不铺 100 MB 的 npm 全家桶。
      const tarPath = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
      const extract = spawnSync(tarPath, ['-xf', zipDest, '-C', voiceRuntimeDir(), '--include', `*/${basename(NODE_RUNTIME_ZIP.inner)}`], {
        encoding: 'utf8',
        windowsHide: true
      })
      const extractedNode = join(voiceRuntimeDir(), NODE_RUNTIME_ZIP.inner)
      if (extract.status !== 0 || !existsSync(extractedNode)) {
        const tail = (extract.stderr ?? '').slice(-200)
        throw new Error(`解压 node.exe 失败（tar 退出码 ${extract.status}${tail ? `：${tail}` : ''}）`)
      }
      renameSync(extractedNode, voiceRuntimeNode())
      // --include 过滤后，版本目录里只剩这一个文件，搬空即删。
      rmSync(dirname(extractedNode), { recursive: true, force: true })
      rmSync(zipDest, { force: true })

      const meta: VoiceRuntimeJson = {
        nodeVersion: NODE_RUNTIME_ZIP.version,
        installedAt: Date.now(),
        nodeZipSha256: NODE_RUNTIME_ZIP.sha256
      }
      writeFileSync(join(voiceRuntimeDir(), VOICE_RUNTIME_RUNTIME_JSON), JSON.stringify(meta, null, 2), 'utf8')
      resetNodeProbe()
      report(1, 'done')
      console.log('VOICE_RUNTIME_READY', JSON.stringify({ node: voiceRuntimeNode() }))
    }
  })
  if (result.kind === 'busy') return { ok: false, error: '正在安装，等这一轮结束再点' }
  return result.kind === 'done' ? { ok: true, error: null } : { ok: false, error: result.error }
}


/**
 * worker 脚本定位（识别与离线朗读同一份规则）：探针从 out/main 起（app.getAppPath()
 * 是 out/main），打包后在 resourcesPath 下（electron-builder.yml 的 extraResources）。
 */
export function locateWorkerScript(baseName: string): string {
  const candidates = [
    join(process.resourcesPath ?? '', baseName),
    join(__dirname, '../../resources', baseName),
    join(app.getAppPath(), 'resources', baseName)
  ]
  return candidates.find((candidate) => candidate && existsSync(candidate)) ?? candidates[candidates.length - 1]
}


