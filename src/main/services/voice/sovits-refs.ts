import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, join, resolve, sep } from 'node:path'
import type { SovitsRefEntry } from '@shared/ipc'

/** 参考音频库的位置：<数据根>/tts/sovits-refs/，refs.json 在这一层，音色各占一个子目录。 */
export function sovitsRefsRoot(userDataDir: string): string {
  return join(userDataDir, 'tts', 'sovits-refs')
}

/**
 * 单条索引的形态校验：字段齐、类型对、路径必须是库内的相对路径。
 * refs.json 是手编文件，一条写坏不能连累其余条目，更不能把路径读出库外。
 */
function parseEntry(raw: unknown, root: string): SovitsRefEntry | null {
  if (typeof raw !== 'object' || raw === null) return null
  const rec = raw as Record<string, unknown>
  const name = typeof rec.name === 'string' ? rec.name.trim() : ''
  const audio = typeof rec.audio === 'string' ? rec.audio.trim() : ''
  const promptText = typeof rec.promptText === 'string' ? rec.promptText.trim() : ''
  const promptLang = rec.promptLang === 'en' ? 'en' : rec.promptLang === 'zh' ? 'zh' : null
  if (!name || !audio || !promptText || !promptLang) return null
  // 只收 POSIX 风格的库内相对路径：反斜杠、..、绝对路径一律拒绝。
  if (audio.includes('\\') || audio.includes('..') || isAbsolute(audio)) return null
  const segments = audio.split('/').filter(Boolean)
  if (segments.length === 0) return null
  const resolvedRoot = resolve(root)
  const audioPath = resolve(join(resolvedRoot, ...segments))
  if (!audioPath.startsWith(resolvedRoot + sep)) return null
  if (!existsSync(audioPath)) return null
  return { name, audio, audioPath, promptText, promptLang }
}

/**
 * 读参考音频库清单。纯函数（库根由调用方传入），探针用临时目录即可覆盖：
 * 索引缺失 / 坏 JSON / 非数组 → 空清单 + 日志，绝不抛；坏条目与缺失音频逐条跳过。
 */
export function listSovitsRefs(root: string): SovitsRefEntry[] {
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
    const entry = parseEntry(item, root)
    if (entry) entries.push(entry)
    else console.warn(`[sovits-refs] 跳过不合法或音频缺失的索引条目：${JSON.stringify(item)}`)
  }
  return entries
}
