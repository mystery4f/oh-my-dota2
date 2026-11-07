/**
 * 语音运行时的纯规则：目录名、下载清单（含钉死的体积与哈希）、候选顺序、状态推导。
 *
 * 为什么单开一个共享模块：识别（sherpa-asr）与离线朗读（offline）共用同一条
 * 「真 node.exe + sherpa 插件」运行链，此前两家各写一遍 node 解析；安装版里
 * sherpa 包又不在 asar 里，用户照提示装了 node 也救不回来（#45）。
 * 规则只有一种写法：纯函数不碰 fs/网络，副作用全部在
 * src/main/services/voice/runtime.ts，探针（--voice-runtime-probe）锁两边。
 */

/** node.exe 运行时压缩包：npmmirror 国内源，体积与哈希实测钉死（#45 立项时验证）。 */
export const NODE_RUNTIME_ZIP = {
  url: 'https://registry.npmmirror.com/-/binary/node/v22.21.0/node-v22.21.0-win-x64.zip',
  bytes: 35546209,
  sha256: '84d31df6571c3c7156707265bf51e2a021656fa1584bf6f4486b792dcde54d7d',
  /** zip 里 node.exe 的真实路径（tar --include 按它过滤，只落这 85 MB 的一个文件）。 */
  inner: 'node-v22.21.0-win-x64/node.exe',
  version: 'v22.21.0'
} as const

/** worker 要能 require 到的两个包；从应用包里拷进运行时，不走网络。 */
export const SHERPA_PACKAGES = ['sherpa-onnx-node', 'sherpa-onnx-win-x64'] as const

/** Qwen3-ASR int8 模型：hf-mirror 按文件直下（不用 878MB 的 tar.bz2）。 */
const QWEN3_MODEL_REPO = 'csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25'
export const QWEN3_MODEL_TOTAL_BYTES = 986491745

export interface RuntimeModelFile {
  /** 相对模型目录的落盘路径（tokenizer 三件在子目录里）。 */
  path: string
  bytes: number
  sha256: string
}

/** 六件套：三个 onnx + tokenizer 三件；哈希全部对照本地出厂副本逐字节钉死。 */
export const QWEN3_MODEL_FILES: readonly RuntimeModelFile[] = [
  { path: 'conv_frontend.onnx', bytes: 44148281, sha256: 'd22dc4423e0940e49884e903d2ea2f7e5567c14fc1aed97e4e26d6b8f208ef9e' },
  { path: 'encoder.int8.onnx', bytes: 182491662, sha256: '60748d3e6744a57c9c91e1b17424a6c2990567e8adceb0783940c03ed98fa9d9' },
  { path: 'decoder.int8.onnx', bytes: 755914231, sha256: '4f6885be5959ae26af3089d38ee7972c5fafbeeb1cf8d5e76eab6d8b61ca5771' },
  { path: 'tokenizer/vocab.json', bytes: 2776833, sha256: 'ca10d7e9fb3ed18575dd1e277a2579c16d108e32f27439684afa0e10b1440910' },
  { path: 'tokenizer/merges.txt', bytes: 1671853, sha256: '8831e4f1a044471340f7c0a83d7bd71306a5b867e95fd870f74d0c5308a904d5' },
  { path: 'tokenizer/tokenizer_config.json', bytes: 12487, sha256: '4942d005604266809309cabc9f4e9cb89ce855d59b14681fdc0e1cc62ea26c4c' }
]

/** hf-mirror 直链：仓库文件按名取，GitHub 原链只作 tar.bz2 手动兜底（不在这条链上）。 */
export function hfMirrorFileUrl(file: string): string {
  return `https://hf-mirror.com/${QWEN3_MODEL_REPO}/resolve/main/${file}`
}

/** 数据目录下运行时的两个子目录名（常量收口，别在字符串里散落）。 */
export const VOICE_RUNTIME_DIR_NAME = 'voice-runtime'
export const VOICE_RUNTIME_NODE_MODULES = 'node_modules'
export const VOICE_RUNTIME_RUNTIME_JSON = 'runtime.json'
export const VOICE_RUNTIME_MODELS_DIR = 'models'

/**
 * NODE_PATH 拼接：运行时的 node_modules 前置——子进程 require 先看运行时，
 * 再看环境里已有的（已有 NODE_PATH 时前置拼接，不覆盖）。
 */
export function joinNodePath(runtimeModules: string, existing?: string): string {
  const rest = (existing ?? '').split(/[;]/).map((part) => part.trim()).filter(Boolean)
  return [runtimeModules, ...rest].join(';')
}

/**
 * node 解析顺序：应用自带的运行时 → 环境变量指定 → PATH。
 * 每个候选都可能不存在或跑不起来，由调用方逐个 spawnSync -v 验证。
 */
export function nodeCandidates(runtimeNode: string): string[] {
  return [runtimeNode, process.env.OHMYDOTA2_NODE, 'node'].filter((value): value is string => Boolean(value))
}

/** runtime.json 的磁盘形状：装失败不写文件，读到就当装好（重装覆盖）。 */
export interface VoiceRuntimeJson {
  nodeVersion: string
  installedAt: number
  nodeZipSha256: string
}

export function parseRuntimeJson(text: string): VoiceRuntimeJson | null {
  try {
    const value = JSON.parse(text) as Partial<VoiceRuntimeJson>
    if (typeof value.nodeVersion !== 'string' || typeof value.installedAt !== 'number') return null
    if (typeof value.nodeZipSha256 !== 'string') return null
    return { nodeVersion: value.nodeVersion, installedAt: value.installedAt, nodeZipSha256: value.nodeZipSha256 }
  } catch {
    return null
  }
}

export type VoiceRuntimeState = 'ready' | 'not-installed' | 'broken'

/**
 * 运行时三态：node.exe + 两个 sherpa 包 + runtime.json 全齐才是 ready；
 * 有 node 没插件（装失败的残留）是 broken——面板要能分辨「重试」和「第一次装」。
 */
export function runtimeStateFromDisk(facts: {
  nodeExists: boolean
  packagesPresent: Record<string, boolean>
  json: VoiceRuntimeJson | null
}): VoiceRuntimeState {
  if (!facts.nodeExists && !facts.json) return 'not-installed'
  const missing = SHERPA_PACKAGES.filter((name) => !facts.packagesPresent[name])
  if (facts.nodeExists && facts.json && missing.length === 0) return 'ready'
  return 'broken'
}

export type VoiceModelState = 'ready' | 'missing' | 'partial'

/** 模型六件套的落盘事实：路径 → 字节数（不存在 = -1）。 */
export type ModelFileSizes = Record<string, number>

/**
 * 按字节数判每件是否齐（哈希校验是下载后的副作用，这里只做便宜判）。
 * 六件全齐且大小对 → ready；一件都没有 → missing；中间态 → partial。
 */
export function modelStateFromDisk(sizes: ModelFileSizes): { state: VoiceModelState; missing: string[] } {
  const missing = QWEN3_MODEL_FILES.filter((file) => (sizes[file.path] ?? -1) !== file.bytes).map((file) => file.path)
  if (missing.length === 0) return { state: 'ready', missing }
  if (missing.length === QWEN3_MODEL_FILES.length) return { state: 'missing', missing }
  return { state: 'partial', missing }
}

/**
 * 下载清单：字节数已对的跳过（断点续传重进不重下），其余按清单顺序排。
 * 半截的 `<path>.part` 不算齐——续传由 downloadResumable 接手。
 */
export function pendingModelFiles(sizes: ModelFileSizes): RuntimeModelFile[] {
  return QWEN3_MODEL_FILES.filter((file) => (sizes[file.path] ?? -1) !== file.bytes)
}
