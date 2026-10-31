import { existsSync, readFileSync } from 'node:fs'
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

/**
 * 库内相对路径的统一校验：POSIX 风格、不能是 .. 或绝对路径、解析后必须落在 base 里。
 * 参考音频和微调权重共用这一套规则，读不出去也读不出数据根。
 */
function resolveUnderBase(rawPath: string, base: string): string | null {
  if (!rawPath || rawPath.includes('\\') || rawPath.includes('..') || isAbsolute(rawPath)) return null
  const segments = rawPath.split('/').filter(Boolean)
  if (segments.length === 0) return null
  const resolvedBase = resolve(base)
  const fullPath = resolve(join(resolvedBase, ...segments))
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
 * 读参考音频库清单。纯函数（库根由调用方传入），探针用临时目录即可覆盖：
 * 索引缺失 / 坏 JSON / 非数组 → 空清单 + 日志，绝不抛；坏条目与缺失音频逐条跳过。
 *
 * weightsRoot 给了才会接受带微调权重的条目；没给时这类条目按「无法核实」整条剔除。
 */
export function listSovitsRefs(root: string, weightsRoot?: string): SovitsRefEntry[] {
  const file = join(root, 'refs.json')
  if (!existsSync(file)) return []
  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(file, 'utf-8'))
  } catch (err) {
    console.warn(`[sovits-refs] refs.json 解析失败，参考库按空处理：${err instanceof Error ? err.message : String(err)}`)
    return []
  }
  if (!Array.isArray(raw)) {
    console.warn('[sovits-refs] refs.json 不是数组，参考库按空处理')
    return []
  }
  const entries: SovitsRefEntry[] = []
  for (const item of raw) {
    const entry = parseEntry(item, root, weightsRoot)
    if (entry) entries.push(entry)
    else console.warn(`[sovits-refs] 跳过不合法或音频缺失的索引条目：${JSON.stringify(item)}`)
  }
  return groupRefsForDisplay(entries)
}

/**
 * 展示顺序：按名字前缀（「·」前的音色名）分组聚拢，组间按首次出现排，组内保持文件序。
 * 音色包和保底参考是往 refs.json 尾部追加的，不聚拢的话「晓晓（保底）」
 * 会孤零零吊在队尾，离「晓晓·原速」隔着一串别的音色。
 */
export function groupRefsForDisplay(entries: SovitsRefEntry[]): SovitsRefEntry[] {
  const groupIndex = new Map<string, number>()
  return [...entries]
    .map((entry) => {
      // 「晓晓·原速」和「晓晓（保底）」是同一族：前缀取「·」或「（」之前的那段。
      const group = entry.name.split('·')[0]?.split('（')[0] ?? entry.name
      if (!groupIndex.has(group)) groupIndex.set(group, groupIndex.size)
      return { entry, order: groupIndex.get(group) ?? 0 }
    })
    .sort((a, b) => a.order - b.order)
    .map((item) => item.entry)
}
