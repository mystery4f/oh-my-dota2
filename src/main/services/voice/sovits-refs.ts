import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { errorMessage } from '@shared/errors'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { SovitsRefEntry } from '@shared/ipc'

/** 参考音频库的位置：<数据根>/tts/sovits-refs/，refs.json 在这一层，音色各占一个子目录。 */
export function sovitsRefsRoot(userDataDir: string): string {
  return join(userDataDir, 'tts', 'sovits-refs')
}

/**
 * 微调权重（GPT ckpt + SoVITS pth）的落位：<数据根>/gpt-sovits/weights/<音色>/<文件>。
 * 放数据根而不是引擎包里：重装/升级引擎包不会把训练产物一起冲掉。
 */
export function sovitsWeightsRoot(userDataDir: string): string {
  return join(userDataDir, 'gpt-sovits', 'weights')
}

/** 参考库索引文件：<库根>/refs.json。读写都从这里取路径，别在调用点拼文件名。 */
export function sovitsRefsFile(root: string): string {
  return join(root, 'refs.json')
}

export interface SafeRelPathOptions {
  /** 最长字符数；不传则不限制。 */
  maxLength?: number
  /** 必须至少两段（<目录>/<文件>）。 */
  requireDir?: boolean
  /** 冒号一律拒绝（Windows 盘符、URL scheme 都从这里混进来）。 */
  forbidColon?: boolean
}

/**
 * 库内相对路径的唯一校验：POSIX 风格、非空段、不绝对、不 . 或 ..。
 * 参考音频、微调权重、远端清单共用这一条规则，差别只在调用方传的选项里。
 */
export function isSafeRelPath(raw: unknown, options: SafeRelPathOptions = {}): raw is string {
  if (typeof raw !== 'string') return false
  if (!raw || raw.includes('\\') || isAbsolute(raw)) return false
  if (options.maxLength !== undefined && raw.length > options.maxLength) return false
  if (options.forbidColon && raw.includes(':')) return false
  if (/^[a-zA-Z]:/.test(raw)) return false
  const segments = raw.split('/')
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) return false
  return options.requireDir ? segments.length >= 2 : true
}

/**
 * 库内相对路径的统一校验：POSIX 风格、不能是 .. 或绝对路径、解析后必须落在 base 里。
 * 参考音频和微调权重共用这一套规则，读不出去也读不出数据根。
 */
function resolveUnderBase(rawPath: string, base: string): string | null {
  if (!isSafeRelPath(rawPath)) return null
  const resolvedBase = resolve(base)
  const fullPath = resolve(join(resolvedBase, ...rawPath.split('/')))
  if (!fullPath.startsWith(resolvedBase + sep)) return null
  return existsSync(fullPath) ? fullPath : null
}

/**
 * 单条索引的形态校验：字段齐、类型对、路径必须是库内的相对路径。
 * refs.json 是手编文件，一条写坏不能连累其余条目，更不能把路径读出库外。
 *
 * 微调权重（gptWeights / sovitsWeights，相对 <数据根>/gpt-sovits/weights/）是可选字段，
 * 但「声明了就必须真的在」：权重文件缺失时整条剔除而不是悄悄退回底座——
 * 下拉框标着「风行者」出来却是零样本音色，比没有这个选项糟糕得多。
 */
function parseEntry(raw: unknown, root: string, weightsRoot: string | undefined): SovitsRefEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>
  const name = typeof rec.name === 'string' ? rec.name.trim() : ''
  const audio = typeof rec.audio === 'string' ? rec.audio.trim() : ''
  const promptText = typeof rec.promptText === 'string' ? rec.promptText.trim() : ''
  const promptLang = rec.promptLang === 'en' ? 'en' : rec.promptLang === 'zh' ? 'zh' : null
  if (!name || !audio || !promptText || !promptLang) return null
  const audioPath = resolveUnderBase(audio, root)
  if (!audioPath) return null
  // 权重字段：字符串 + 非空才算「声明了」；空串/缺省视为不带微调（底座零样本）。
  const gptWeights = typeof rec.gptWeights === 'string' ? rec.gptWeights.trim() : ''
  const sovitsWeights = typeof rec.sovitsWeights === 'string' ? rec.sovitsWeights.trim() : ''
  if (gptWeights || sovitsWeights) {
    if (!weightsRoot) return null
    // 半装状态（声明了一边、另一边没写）同样算坏：训练权重必须成对切。
    if (!gptWeights || !sovitsWeights) return null
    const gptWeightsPath = resolveUnderBase(gptWeights, weightsRoot)
    const sovitsWeightsPath = resolveUnderBase(sovitsWeights, weightsRoot)
    if (!gptWeightsPath || !sovitsWeightsPath) return null
    return { name, audio, audioPath, promptText, promptLang, gptWeights, sovitsWeights, gptWeightsPath, sovitsWeightsPath }
  }
  return { name, audio, audioPath, promptText, promptLang }
}

/**
 * 读 refs.json 的原始条目（不校验）：文件缺失、坏 JSON、非数组一律当空表。
 * 读取保持无副作用——坏文件的备份发生在写入前，而不是每次刷新面板都改名。
 */
export function readRefsRaw(root: string): unknown[] {
  const file = sovitsRefsFile(root)
  if (!existsSync(file)) return []
  try {
    const raw: unknown = JSON.parse(readFileSync(file, 'utf-8'))
    if (Array.isArray(raw)) return raw
    console.warn('[sovits-refs] refs.json 不是数组，按空表处理')
  } catch (err) {
    console.warn(`[sovits-refs] refs.json 解析失败，按空表处理：${errorMessage(err)}`)
  }
  return []
}

/** 写入前把解析不了的原文件改名留档：宁可多一个 .broken 文件，也不能把用户手编的条目直接抹掉。 */
function backupCorruptRefs(root: string): void {
  const file = sovitsRefsFile(root)
  if (!existsSync(file)) return
  try {
    JSON.parse(readFileSync(file, 'utf-8'))
    return
  } catch {
    // 解析不了才继续往下备份。
  }
  const backup = `${file}.broken-${Date.now()}`
  try {
    renameSync(file, backup)
    console.warn(`[sovits-refs] refs.json 无法解析，已备份为 ${backup}`)
  } catch (err) {
    console.warn(`[sovits-refs] refs.json 无法解析且备份失败：${errorMessage(err)}`)
  }
}

/** 原子写回 refs.json：先写同目录临时文件再 rename，断电或并发只丢这一次写入，不留半个 JSON。 */
export function writeRefsRaw(root: string, list: unknown[]): void {
  backupCorruptRefs(root)
  mkdirSync(root, { recursive: true })
  const file = sovitsRefsFile(root)
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`, 'utf-8')
  renameSync(tmp, file)
}

/**
 * 读参考音频库清单。纯函数（库根由调用方传入），探针用临时目录即可覆盖：
 * 索引缺失 / 坏 JSON / 非数组 → 空清单 + 日志，绝不抛；坏条目与缺失音频逐条跳过。
 *
 * weightsRoot 给了才会接受带微调权重的条目；没给时这类条目按「无法核实」整条剔除。
 */
export function listSovitsRefs(root: string, weightsRoot?: string): SovitsRefEntry[] {
  const entries: SovitsRefEntry[] = []
  for (const item of readRefsRaw(root)) {
    const entry = parseEntry(item, root, weightsRoot)
    if (entry) entries.push(entry)
    else console.warn(`[sovits-refs] 跳过不合法或音频缺失的索引条目：${JSON.stringify(item)}`)
  }
  return groupRefsForDisplay(entries)
}

/**
 * 展示顺序：游戏角色语音（米拉娜、风行者）固定排最前，其余按名字前缀（「·」前的音色名）
 * 分组聚拢，组间按首次出现排，组内保持文件序。音色包和保底参考是往 refs.json 尾部追加的，
 * 不聚拢的话「晓晓（保底）」会孤零零吊在队尾，离「晓晓·原速」隔着一串别的音色。
 */
const PRIORITY_GROUPS = ['米拉娜', '风行者']

export function groupRefsForDisplay(entries: SovitsRefEntry[]): SovitsRefEntry[] {
  const firstSeen = new Map<string, number>()
  let counter = 0
  return [...entries]
    .map((entry) => {
      // 「晓晓·原速」和「晓晓（保底）」是同一族：前缀取「·」或「（」之前的那段。
      const group = entry.name.split('·')[0]?.split('（')[0] ?? entry.name
      if (!firstSeen.has(group)) firstSeen.set(group, counter++)
      const priority = PRIORITY_GROUPS.indexOf(group)
      const rank = priority >= 0 ? priority : PRIORITY_GROUPS.length + (firstSeen.get(group) ?? 0)
      return { entry, rank }
    })
    .sort((a, b) => a.rank - b.rank)
    .map((item) => item.entry)
}
