import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import net from 'node:net'
import { createInterface } from 'node:readline'
import { app } from 'electron'
import type { SovitsRefEntry, SovitsStatus } from '@shared/ipc'
import { loadSettings, saveSettings } from '../settings'
import { listSovitsRefs, sovitsRefsRoot, sovitsWeightsRoot } from './sovits-refs'
import { sovitsInstallHome, sovitsInstallRoot, sovitsInstallState, sovitsInstalled } from './sovits-install'
import { resetSovitsCache } from './sovits-cache'

/**
 * GPT-SoVITS api_v2 的进程托管：选了 sovits 引擎就由应用自己拉起引擎包里的服务，
 * 用户不需要手动开窗口、跑命令。机器重启后也一样——应用起来它就起来。
 *
 * 两个环境坑（2026-10-27 实测，见 wiki obs-2026-10-27-gpt-sovits-api-v2-gbk-ffmpeg）：
 *   1. PYTHONIOENCODING=utf-8：Windows GBK 控制台会把真实异常吞成 'gbk' codec 编码错；
 *   2. PATH 前置 <home>\runtime：ffmpeg.exe 在那里面，不在 PATH 里 librosa 解不开 mp3 参考。
 *
 * 目录发现（discoverSovitsHome）：面板填的 ttsSovitsHome 优先；没填看应用自装位
 * （`<userData>/gpt-sovits/…`，一键下载装的）。再没有了就空串——绝不猜本机某个
 * D:\AI 之类的手工安装位：安装版用户没有它，静默兜底只会让「换机器就哑」更难排查。
 * 模型加载约 15-40 秒，所以启动钩子在 app ready 时就拉、不等到第一句聊天。
 * 端口已被占（用户自己起了或上一轮还活着）就直接复用，绝不起第二份。
 */

export type SovitsServerPhase = 'off' | 'starting' | 'ready' | 'external'

let child: ChildProcess | null = null
let ensuring: Promise<boolean> | null = null
let phase: SovitsServerPhase = 'off'
let phaseDetail = '还没启动过'
let phaseSince = Date.now()

/** 日志环形缓冲：面板「日志」折叠框看这里，合成成败/进程生死一目了然，不用翻控制台。 */
const LOG_LIMIT = 300
const logRing: string[] = []

/** sovits 全家（server + 合成 + 安装）共用的留痕：控制台一行 + 环形缓冲一行。 */
export function recordSovitsLog(prefix: string, data?: Record<string, unknown>): void {
  const time = new Date().toISOString().slice(11, 19)
  const line = data === undefined ? `${time} ${prefix}` : `${time} ${prefix} ${JSON.stringify(data)}`
  console.log(line)
  logRing.push(line)
  if (logRing.length > LOG_LIMIT) logRing.splice(0, logRing.length - LOG_LIMIT)
}

export function sovitsServerLogs(): string[] {
  return [...logRing]
}

/**
 * 持续消费子进程输出：逐行读、裁到 500 字符（pytorch 进度条一行会无限长）、
 * 空行丢弃，进同一个日志环形缓冲。uvicorn 的访问日志在 stdout，异常在 stderr。
 */
function pipeProcessOutput(tag: string, stream: NodeJS.ReadableStream | null): void {
  if (!stream) return
  const lines = createInterface({ input: stream, crlfDelay: Infinity })
  lines.on('line', (line: string) => {
    const text = line.trim()
    if (!text) return
    recordSovitsLog(tag, { line: text.slice(0, 500) })
  })
}

function setPhase(next: SovitsServerPhase, detail: string): void {
  phase = next
  phaseDetail = detail
  phaseSince = Date.now()
}

function serverPort(baseUrl: string): number {
  try {
    return Number(new URL(baseUrl).port) || 9880
  } catch {
    return 9880
  }
}

/** TCP 连得上就算服务在：api_v2 在模型加载完之后才开始监听。 */
function portOpen(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: '127.0.0.1' })
    socket.setTimeout(1200)
    socket.once('connect', () => {
      socket.destroy()
      resolve(true)
    })
    socket.once('timeout', () => {
      socket.destroy()
      resolve(false)
    })
    socket.once('error', () => resolve(false))
  })
}

/** 引擎包目录发现：面板显式配置 → 应用自装位；没有就空串（状态面板会如实显示未安装）。 */
export function discoverSovitsHome(): string {
  const explicit = loadSettings().ttsSovitsHome.trim()
  if (explicit) return explicit
  if (sovitsInstalled()) return sovitsInstallHome()
  return ''
}
function homeUsable(home: string): boolean {
  return existsSync(join(home, 'runtime', 'python.exe')) && existsSync(join(home, 'api_v2.py'))
}


export async function sovitsServerReady(): Promise<boolean> {
  const settings = loadSettings()
  return portOpen(serverPort(settings.ttsSovitsUrl || 'http://127.0.0.1:9880'))
}

/**
 * 确保服务在跑：已在监听 → 复用；引擎包在 → 拉起并等端口就绪；包不在/超时 → false
 * （朗读侧拿到 null 静默跳过这一句，绝不回退系统嗓子）。
 */
/** 首句预热：合成两个字直接丢掉；参考没配就跳过（预热也会 400）。 */
async function warmupSovits(port: number): Promise<void> {
  const settings = loadSettings()
  if (!settings.ttsSovitsRefAudio || !settings.ttsSovitsPromptText) return
  const query = new URLSearchParams({
    text: '预备',
    text_lang: 'zh',
    ref_audio_path: settings.ttsSovitsRefAudio,
    prompt_text: settings.ttsSovitsPromptText,
    prompt_lang: 'zh',
    media_type: 'wav',
    streaming_mode: 'false',
    batch_size: '8',
    parallel_infer: 'false',
    speed_factor: '1'
  })
  const started = Date.now()
  try {
    const response = await fetch(`http://127.0.0.1:${port}/tts?${query.toString()}`, { signal: AbortSignal.timeout(60_000) })
    const bytes = response.ok ? (await response.arrayBuffer()).byteLength : 0
    recordSovitsLog('TTS_SOVITS_SERVER_WARMUP', { ms: Date.now() - started, bytes })
  } catch (err) {
    recordSovitsLog('TTS_SOVITS_SERVER_WARMUP_FAIL', { err: err instanceof Error ? err.message : String(err) })
  }
}

/** 当前已加载的微调权重（幂等键）：同一音色重复选择/重启恢复时跳过重复切换。 */
let appliedWeightsKey: string | null = null

/**
 * 切换微调权重：api_v2 的 /set_gpt_weights + /set_sovits_weights（免重启换音色）。
 * entry 不带权重 = 底座零样本，什么都不切（清掉幂等键即可）。切换要 torch.load
 * 几百 MB 的 ckpt，超时给足 180s；失败返回 false，底座权重还在，朗读下一句照旧。
 */
export async function applySovitsVoice(
  port: number,
  entry: Pick<SovitsRefEntry, 'gptWeightsPath' | 'sovitsWeightsPath'> | null
): Promise<boolean> {
  const gptPath = entry?.gptWeightsPath
  const sovitsPath = entry?.sovitsWeightsPath
  // 不带权重（底座零样本）或带了但有一边缺失：不切，只清幂等键。
  if (!gptPath || !sovitsPath) {
    appliedWeightsKey = null
    return true
  }
  const key = `${gptPath}|${sovitsPath}`
  if (key === appliedWeightsKey) return true
  const started = Date.now()
  try {
    const targets: Array<[string, string]> = [
      ['set_gpt_weights', gptPath],
      ['set_sovits_weights', sovitsPath]
    ]
    for (const [endpoint, path] of targets) {
      const query = new URLSearchParams({ weights_path: path })
      const response = await fetch(`http://127.0.0.1:${port}/${endpoint}?${query.toString()}`, {
        signal: AbortSignal.timeout(180_000)
      })
      if (!response.ok) throw new Error(`${endpoint} HTTP ${response.status}`)
    }
    appliedWeightsKey = key
    // 音色换了，重复句缓存里全是旧音色的音频，整包清掉（ADR docs/adr/tts-repeat-cache.md）。
    resetSovitsCache()
    recordSovitsLog('TTS_SOVITS_SET_WEIGHTS', { ms: Date.now() - started })
    return true
  } catch (err) {
    recordSovitsLog('TTS_SOVITS_SET_WEIGHTS_FAIL', { err: err instanceof Error ? err.message : String(err) })
    return false
  }
}

/**
 * 启动恢复：服务就绪后按当前设置里的参考音频找回条目，把它声明的微调权重切上，
 * 再做首句预热。找不到条目（手填路径 / 库被清空）就只预热——零样本也能出声。
 */
async function restoreSovitsVoice(port: number): Promise<void> {
  try {
    const settings = loadSettings()
    const userData = app.getPath('userData')
    const refs = listSovitsRefs(sovitsRefsRoot(userData), sovitsWeightsRoot(userData))
    const entry = refs.find((ref) => ref.audioPath === settings.ttsSovitsRefAudio)
    if (entry) await applySovitsVoice(port, entry)
  } catch (err) {
    recordSovitsLog('TTS_SOVITS_RESTORE_FAIL', { err: err instanceof Error ? err.message : String(err) })
  }
  await warmupSovits(port)
}

/** 设置里 ttsSovitsUrl 对应的本地端口（合成 / 切权重 / 预热共用一个真相源）。 */
export function currentSovitsPort(): number {
  return serverPort(loadSettings().ttsSovitsUrl || 'http://127.0.0.1:9880')
}

/**
 * 激活一条参考音频：写设置 → 确保服务在 → 切微调权重 → 首句预热。
 * 面板下拉选择、音色包装完自动选中、启动恢复三路共用，保证顺序一致：
 * 先把参考落进设置，再切权重，最后预热——预热用的就是刚写进去的参考。
 */
export async function activateSovitsRef(
  entry: Pick<SovitsRefEntry, 'audioPath' | 'promptText' | 'promptLang' | 'gptWeightsPath' | 'sovitsWeightsPath'>
): Promise<boolean> {
  saveSettings({
    ttsSovitsRefAudio: entry.audioPath,
    ttsSovitsPromptText: entry.promptText,
    ttsSovitsPromptLang: entry.promptLang
  })
  const port = currentSovitsPort()
  if (!(await ensureSovitsServer())) return false
  await applySovitsVoice(port, entry)
  await warmupSovits(port)
  return true
}

export async function ensureSovitsServer(): Promise<boolean> {
  const settings = loadSettings()
  const port = serverPort(settings.ttsSovitsUrl || 'http://127.0.0.1:9880')
  if (await portOpen(port)) {
    if (child && child.exitCode === null) setPhase('ready', '服务运行中（应用托管）')
    else setPhase('external', '端口已有服务在跑，直接复用')
    return true
  }
  const home = discoverSovitsHome()
  if (!homeUsable(home)) {
    setPhase('off', `引擎包不完整：${home}`)
    recordSovitsLog('TTS_SOVITS_SERVER_FAIL', { reason: 'install-not-found', home })
    return false
  }
  if (ensuring) return ensuring
  const started = Date.now()
  setPhase('starting', '拉起服务，加载模型约 15-40 秒')
  ensuring = (async () => {
    recordSovitsLog('TTS_SOVITS_SERVER_START', { home, port })
    const spawned = spawn(join(home, 'runtime', 'python.exe'), ['api_v2.py', '-a', '127.0.0.1', '-p', String(port), '-c', 'GPT_SoVITS/configs/tts_infer.yaml'], {
      cwd: home,
      windowsHide: true,
      // stdout/stderr 都要管道并持续消费：pytorch 加载的警告、真实异常全在 stderr 里
      // （GBK 控制台吞异常的教训）；管道没人读会积满缓冲把 python 卡死。
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PATH: `${join(home, 'runtime')};${process.env.PATH ?? ''}`
      }
    })
    pipeProcessOutput('TTS_SOVITS_API_OUT', spawned.stdout)
    pipeProcessOutput('TTS_SOVITS_API_ERR', spawned.stderr)
    spawned.on('error', (err) => {
      recordSovitsLog('TTS_SOVITS_SERVER_FAIL', { err: err.message })
    })
    spawned.on('exit', (code) => {
      recordSovitsLog('TTS_SOVITS_SERVER_EXIT', { code })
      if (child === spawned) {
        child = null
        if (phase === 'starting' || phase === 'ready') setPhase('off', `服务进程退出（code ${code}）`)
      }
    })
    child = spawned
    // 模型加载约 15-40s；上限 150s，超了就放弃（这句不念，下一句进来再试）。
    const deadline = Date.now() + 150_000
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 1500))
      if (await portOpen(port)) {
        recordSovitsLog('TTS_SOVITS_SERVER_READY', { ms: Date.now() - started, pid: spawned.pid })
        // 预热推理：READY 只代表端口开了，第一次真实合成还要付一遍 CUDA/懒加载（实测 5-12s）。
        // 起服就先合成一句废话扔掉，把这笔代价挪到没人说话的时候。
        // 新进程是从底座权重起的，旧幂等键必须作废，否则重启后会跳过该切的微调权重。
        appliedWeightsKey = null
        // 新进程权重状态未知（yaml custom 里躺的是上次切的），缓存按旧音色建的，全清。
        resetSovitsCache()
        void restoreSovitsVoice(port)
        if (child === spawned) setPhase('ready', '服务运行中（应用托管）')
        else setPhase('external', '端口已有服务在跑，直接复用')
        return true
      }
      // 进程没活到端口开：再等也只是空转。
      if (spawned.exitCode !== null) break
    }
    recordSovitsLog('TTS_SOVITS_SERVER_TIMEOUT', { ms: Date.now() - started })
    if (child === spawned) {
      child = null
      setPhase('off', '启动超时（150 秒），重开应用再试')
    }
    return false
  })()
  try {
    return await ensuring
  } finally {
    ensuring = null
  }
}

/** 应用退出时收掉自己拉的服务；不是我们拉的（child 为空）就什么都不动。 */
export function stopSovitsServer(): void {
  if (!child) return
  const pid = child.pid
  child = null
  if (!pid) return
  // python 可能还有孙进程（dataloader worker），树杀最稳；杀失败也不阻塞退出。
  spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
  setPhase('off', '应用退出时已停止')
  recordSovitsLog('TTS_SOVITS_SERVER_STOP', { pid })
}

/** 面板状态：现场重查端口（进程可能在我们不知道的时候死了），再叠加缓存的状态机。 */
export async function sovitsServerStatus(): Promise<{
  phase: SovitsServerPhase
  detail: string
  sinceMs: number
  home: string
  pid: number | null
}> {
  const settings = loadSettings()
  const port = serverPort(settings.ttsSovitsUrl || 'http://127.0.0.1:9880')
  if (await portOpen(port)) {
    if (phase !== 'ready' && phase !== 'external') {
      if (child && child.exitCode === null) setPhase('ready', '服务运行中（应用托管）')
      else setPhase('external', '端口已有服务在跑，直接复用')
    }
  } else if (phase === 'ready' || phase === 'external') {
    setPhase('off', '服务不在了（端口已关），下一句聊天会自动重拉')
  }
  return { phase, detail: phaseDetail, sinceMs: Date.now() - phaseSince, home: discoverSovitsHome(), pid: child?.pid ?? null }
}

/** 面板要的一整包：安装状态 + 服务状态 + 最近日志。ipc 层直接转发，不做加工。 */
export async function sovitsStatusSnapshot(): Promise<SovitsStatus> {
  const server = await sovitsServerStatus()
  const install = sovitsInstallState()
  return {
    // 「已安装」按实际生效的目录算：用户在面板显式配置的手工安装位也算装好，
    // 面板不该在能出声的时候显示「未安装」再劝人下 8GB。
    installed: homeUsable(server.home),
    archivePresent: install.archivePresent,
    install: { phase: install.phase, progress: install.progress, error: install.error },
    server: { phase: server.phase, detail: server.detail, sinceMs: server.sinceMs, pid: server.pid },
    home: server.home,
    installRoot: sovitsInstallRoot(),
    logs: sovitsServerLogs().slice(-80)
  }
}
