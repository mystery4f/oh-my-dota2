/**
 * 诊断包（#111）的纯缝：收哪些证据、怎么脱敏、manifest 长什么样。
 *
 * 落盘与压缩在主进程（`src/main/services/log-bundle.ts`），这里只做能对着字符串断言的决定，
 * 探针靠这一份就能证明「脱敏真的换了字、换了哪些、没换的有没有被点名」。缺文件不是错误：
 * 一个从没说过话的安装本来就没有 voice-chain.jsonl，manifest 的 missing 就是它的位置。
 */

/** 默认收集的证据文件（相对 `<userData>/logs`），顺序即 manifest 与压缩包里的顺序。 */
export const LOG_BUNDLE_FILES = [
  { name: 'inplace.log', mask: true },
  { name: 'gsi-chat.jsonl', mask: true },
  { name: 'gsi-summary.json', mask: true },
  { name: 'voice-chain.jsonl', mask: true },
  { name: 'capture-ticks.jsonl', mask: true }
] as const

/** manifest 里的一个在场文件。 */
export interface LogBundleFile {
  name: string
  bytes: number
  /** 这一份里有没有字段被替换成占位（没有就是原样入包）。 */
  masked: boolean
}

export interface LogBundleManifest {
  app: string
  version: string
  /** `out/main/index.js` 的 mtime，与启动日志的 BUILD_STAMP 同源；拿不到就是 null。 */
  buildStamp: string | null
  createdAt: string
  platform: string
  files: LogBundleFile[]
  /** 这次没收到的文件：列出来，不静默跳过。 */
  missing: string[]
}

/** 面板拿到的导出结果；失败也要有话说，所以 error 与 path 同时存在。 */
export interface LogBundleResult {
  ok: boolean
  path: string | null
  bytes: number
  files: number
  missing: string[]
  error: string | null
}

/** 脱敏后的替身：昵称按首次出现顺序编号，同一局同一个名字拿到同一个号。 */
export function nicknameAlias(index: number): string {
  return `玩家${index}`
}

/** 设备 id 的占位：长度与真 id 无关，免得从占位里反推 id 长度。 */
export const DEVICE_ID_PLACEHOLDER = '********'

const NICK_RE = /"(name|nick)":"((?:[^"\\]|\\.)*)"/g
const MIC_RE = /"mic":"((?:[^"\\]|\\.)*)\|([A-Za-z0-9_-]{1,8})"/g
const DEVICE_RE = /"(deviceId|device_id)":"((?:[^"\\]|\\.)*)"/g

/**
 * 一行里的身份字段换成占位。
 *
 * 只认三个已知键：`name`/`nick`（Dota 昵称，gsi-chat.jsonl 与 gsi-summary.json 都这么写）、
 * `mic`（`label|deviceId 前 8 位`，见 voice-chain.jsonl）、`deviceId`。其余原样——把日志里的
 * 任意字符串都当身份去换，会把译文和句子一起毁掉，那时这份包就没有证据价值了。
 */
export function maskLogLine(line: string, aliases: Map<string, string>): string {
  let out = line.replace(NICK_RE, (whole, key: string, value: string) => {
    if (!value) return whole
    let alias = aliases.get(value)
    if (alias === undefined) {
      alias = nicknameAlias(aliases.size + 1)
      aliases.set(value, alias)
    }
    return `"${key}":"${alias}"`
  })
  out = out.replace(MIC_RE, (whole, label: string, id: string) => {
    if (!id) return whole
    return `"mic":"${label}|${DEVICE_ID_PLACEHOLDER}"`
  })
  out = out.replace(DEVICE_RE, (whole, key: string, value: string) => {
    if (!value || value === DEVICE_ID_PLACEHOLDER) return whole
    return `"${key}":"${DEVICE_ID_PLACEHOLDER}"`
  })
  return out
}

/**
 * 整份日志的脱敏结果。`masked` 决定 manifest 怎么写字：false 表示这份里没有身份字段，
 * 不是「忘了脱敏」——探针分得开这两种情况。
 */
export function maskLogText(text: string, enabled: boolean): { text: string; masked: boolean } {
  if (!enabled || !text) return { text, masked: false }
  const aliases = new Map<string, string>()
  let masked = false
  const lines = text.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const next = maskLogLine(lines[i], aliases)
    if (next !== lines[i]) {
      masked = true
      lines[i] = next
    }
  }
  return { text: lines.join('\n'), masked }
}

/** 只收表里点名的文件，且按表里的顺序——面板列出来的就是包里有的。 */
export function wantedLogFiles(names: readonly string[]): { name: string; mask: boolean }[] {
  const asked = new Set(names)
  return LOG_BUNDLE_FILES.filter((file) => asked.has(file.name)).map((file) => ({ name: file.name, mask: file.mask }))
}

/** 在场文件 + 缺的文件 → manifest。缺的只进 missing，不伪造 0 字节条目。 */
export function buildLogBundleManifest(input: {
  version: string
  buildStamp: string | null
  createdAt: string
  platform: string
  files: readonly LogBundleFile[]
  missing: readonly string[]
}): LogBundleManifest {
  return {
    app: 'oh-my-dota2',
    version: input.version,
    buildStamp: input.buildStamp,
    createdAt: input.createdAt,
    platform: input.platform,
    files: [...input.files],
    missing: [...input.missing]
  }
}
