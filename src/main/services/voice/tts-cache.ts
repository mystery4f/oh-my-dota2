import { app } from 'electron'
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 合成结果缓存。
 *
 * Edge 神经语音每句都要一次跨境往返（实测 700–1600 ms），而 Dota 聊天里重复句极多
 * （`gg`、`wp`、`推上路`、`别送了` 这种一局能出现十几次）。同一句第二次出现时，
 * 网络延迟就是纯浪费——按「嗓子 + 语速 + 音高 + 文本」做键，命中直接出音频。
 *
 * 内存只放最近用到的几百条，磁盘留得住跨局、跨重启。磁盘总量有上限，
 * 超了按最久未用先删，不能让一个朗读功能把硬盘吃掉。
 */
const MAX_MEMORY = 240
const MAX_DISK_BYTES = 24 * 1024 * 1024
const DIR_NAME = 'tts-cache'

const memory = new Map<string, Buffer>()
const touchOrder: string[] = []

function cacheDir(): string {
  const dir = join(app.getPath('userData'), DIR_NAME)
  mkdirSync(dir, { recursive: true })
  return dir
}

export function ttsCacheKey(composite: string): string {
  return createHash('sha1').update(composite).digest('hex')
}

/** 命中返回音频，未命中返回 null。内存没命中时再看磁盘，磁盘命中顺手回填内存。 */
export function readCachedAudio(key: string): Buffer | null {
  const hit = memory.get(key)
  if (hit) return hit
  try {
    const file = join(cacheDir(), `${key}.mp3`)
    if (!existsSync(file)) return null
    const buf = readFileSync(file)
    remember(key, buf)
    return buf
  } catch {
    return null
  }
}

function remember(key: string, audio: Buffer): void {
  memory.set(key, audio)
  const index = touchOrder.indexOf(key)
  if (index >= 0) touchOrder.splice(index, 1)
  touchOrder.push(key)
  while (touchOrder.length > MAX_MEMORY) {
    const oldest = touchOrder.shift()
    if (oldest !== undefined) memory.delete(oldest)
  }
}

/** 写内存 + 落盘。写盘失败不影响本次朗读——缓存是加速手段，不是正确性依赖。 */
export function writeCachedAudio(key: string, audio: Buffer): void {
  remember(key, audio)
  try {
    const dir = cacheDir()
    writeFileSync(join(dir, `${key}.mp3`), audio)
    pruneIfNeeded(dir)
  } catch (err) {
    console.log('TTS_CACHE_WRITE_FAILED', err instanceof Error ? err.message : String(err))
  }
}

/** 目录超过上限就从最旧的开始删，删到上限的 80% 为止。 */
function pruneIfNeeded(dir: string): void {
  const entries = readdirSync(dir)
    .filter((name) => name.endsWith('.mp3'))
    .map((name) => {
      const path = join(dir, name)
      try {
        const info = statSync(path)
        return { path, size: info.size, at: info.mtimeMs }
      } catch {
        return null
      }
    })
    .filter((item): item is { path: string; size: number; at: number } => item !== null)
  let total = entries.reduce((sum, item) => sum + item.size, 0)
  if (total <= MAX_DISK_BYTES) return
  entries.sort((a, b) => a.at - b.at)
  const floor = MAX_DISK_BYTES * 0.8
  for (const item of entries) {
    if (total <= floor) break
    try {
      unlinkSync(item.path)
      total -= item.size
    } catch {
      // 删不掉就跳过，下次再说。
    }
  }
}

/** 探针/日志用：当前内存与磁盘占用。 */
export function ttsCacheStats(): { memoryEntries: number; diskFiles: number; diskBytes: number } {
  let diskFiles = 0
  let diskBytes = 0
  try {
    const dir = cacheDir()
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.mp3')) continue
      diskFiles += 1
      try {
        diskBytes += statSync(join(dir, name)).size
      } catch {
        // 统计失败忽略。
      }
    }
  } catch {
    // 目录不存在时就是 0。
  }
  return { memoryEntries: memory.size, diskFiles, diskBytes }
}
