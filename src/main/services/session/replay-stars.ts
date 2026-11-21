/**
 * 星标的落盘与按局读取（#118）。
 *
 * 记录写在 `logs/replay-stars.jsonl`（`logsDir()` 下，探针模式落临时根），上限 256 KB。
 *
 * 为什么按局存而不是只存内存：复盘是在**对局结束之后**看的，跨对局边界必须还读得到。
 * 归属来自 `liveMatchId()`（只认 90 秒内的活帧），拿不到就写 null，绝不猜上一局。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendCappedJsonl } from '../logs/jsonl'
import { logsDir } from '../logs/base-dir'
import { getCaptureService } from '../capture/capturer'
import { liveMatchId } from '../gsi-match'
import {
  buildStar,
  summarizeStars,
  type ReplayStar,
  type ReplayStarSummary
} from '@shared/replay-star'

const FILE_NAME = 'replay-stars.jsonl'
const MAX_BYTES = 256 * 1024
/** 内存里也只留这么多：复盘按局读，没必要把整份历史读进数组。 */
const MEMORY_KEEP = 400

export function replayStarsPath(): string {
  return join(logsDir(), FILE_NAME)
}

let memory: ReplayStar[] = []
let loaded = false

function isStar(value: unknown): value is ReplayStar {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Partial<ReplayStar>
  return (
    typeof row.entryId === 'string' &&
    row.entryId !== '' &&
    typeof row.source === 'string' &&
    typeof row.translation === 'string' &&
    typeof row.at === 'string' &&
    (row.matchid === null || typeof row.matchid === 'string') &&
    typeof row.note === 'string'
  )
}

function loadOnce(): void {
  if (loaded) return
  loaded = true
  let raw = ''
  try {
    raw = readFileSync(replayStarsPath(), 'utf8')
  } catch {
    memory = []
    return
  }
  const rows: ReplayStar[] = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      const parsed: unknown = JSON.parse(text)
      if (isStar(parsed)) rows.push(parsed)
    } catch {
      // 半行/脏行当没写过：一条坏记录不该让整局的星标读不出来。
    }
  }
  memory = rows.slice(-MEMORY_KEEP)
}

/**
 * 标浮层上最后一条已翻译的行。没有可标的行时返回 null，调用方据此出提示——
 * 绝不凭空造一条空样本。
 */
export function noteReplayStar(note = '', at = new Date().toISOString()): ReplayStar | null {
  loadOnce()
  const ledger = getCaptureService().history(50)
  let target: (typeof ledger)[number] | null = null
  for (let index = ledger.length - 1; index >= 0; index -= 1) {
    const entry = ledger[index]
    if (entry.pending !== true && typeof entry.translated === 'string' && entry.translated.trim() !== '') {
      target = entry
      break
    }
  }
  if (target === null) return null

  const star = buildStar({
    at,
    matchid: liveMatchId(),
    entry: {
      entryId: String(target.id),
      source: String(target.original ?? ''),
      translation: String(target.translated ?? '')
    },
    note
  })
  if (star === null) return null

  memory = [...memory.filter((row) => row.entryId !== star.entryId), star].slice(-MEMORY_KEEP)
  appendCappedJsonl(replayStarsPath(), { ...star }, MAX_BYTES)
  return star
}

/** 某一局的星标汇总。`matchid` 为 null 时读的是「归属不明」那一组。 */
export function replayStarSummary(matchid: string | null): ReplayStarSummary {
  loadOnce()
  return summarizeStars(memory, matchid)
}

/** 探针用：清空内存里的账（不动盘上的历史）。 */
export function resetReplayStars(): void {
  memory = []
  loaded = true
}

/** 探针用：把一批记录直接塞进内存，模拟「上一局的星标还读得到」。 */
export function seedReplayStars(stars: readonly ReplayStar[]): void {
  loaded = true
  memory = [...stars].slice(-MEMORY_KEEP)
}
