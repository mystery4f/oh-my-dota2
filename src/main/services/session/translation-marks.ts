/**
 * 译文抽检的落盘与读取（#87）。
 *
 * 记录写在 `logs/translation-marks.jsonl`（`logsDir()` 下，探针模式下落在临时根），
 * 上限与其它日志一样 256 KB。读的时候按 entryId 去重——同一行先标「差」又改判「好」，
 * 只该算一次，而且算最后那次。
 */
import { join } from 'node:path'
import { appendCappedJsonl } from '../logs/jsonl'
import { logsDir } from '../logs/base-dir'
import { loadSettings } from '../settings'
import { getCaptureService } from '../capture/capturer'
import { liveMatchId } from '../gsi-match'
import { readFileSync } from 'node:fs'
import {
  buildMark,
  summarizeMarks,
  type TranslationMark,
  type TranslationMarkSummary,
  type TranslationVerdict
} from '@shared/translation-mark'

const FILE_NAME = 'translation-marks.jsonl'
const MAX_BYTES = 256 * 1024
/** 内存里也只留这么多：面板只要一句话，没必要把整份日志读进数组。 */
const MEMORY_KEEP = 200

export function translationMarksPath(): string {
  return join(logsDir(), FILE_NAME)
}

let memory: TranslationMark[] = []
let loaded = false

function loadOnce(): void {
  if (loaded) return
  loaded = true
  let raw = ''
  try {
    raw = readFileSync(translationMarksPath(), 'utf8')
  } catch {
    memory = []
    return
  }
  const rows: TranslationMark[] = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      const parsed = JSON.parse(text) as TranslationMark
      if (typeof parsed.entryId === 'string' && (parsed.verdict === 'good' || parsed.verdict === 'bad')) rows.push(parsed)
    } catch {
      // 半行/脏行当没写过：一条坏记录不该让整份抽检读不出来。
    }
  }
  memory = rows.slice(-MEMORY_KEEP)
}

/**
 * 标记浮层上最后一条已翻译的行。没有可标记的行时返回 null（调用方据此出提示），
 * 绝不会凭空造一条空样本。
 */
export function noteTranslationMark(verdict: TranslationVerdict, at = new Date().toISOString()): TranslationMark | null {
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

  const provider = loadSettings().provider
  const mark = buildMark({
    at,
    matchid: liveMatchId(),
    entry: target,
    verdict,
    provider: provider.id,
    model: provider.model
  })
  if (mark === null) return null

  memory = [...memory.filter((row) => row.entryId !== mark.entryId), mark].slice(-MEMORY_KEEP)
  appendCappedJsonl(translationMarksPath(), { ...mark }, MAX_BYTES)
  return mark
}

export function translationMarkSummary(): TranslationMarkSummary {
  loadOnce()
  return summarizeMarks(memory)
}

/** 探针用：清空内存里的账（不动盘上的历史）。 */
export function resetTranslationMarks(): void {
  memory = []
  loaded = true
}
