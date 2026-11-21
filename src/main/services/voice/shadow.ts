/**
 * 影子模式的落盘与状态（#80）。
 *
 * 只做两件事：把「本该念的那句」记进 `logs/shadow-voice.jsonl`，以及回答「现在要不要影子」。
 * 判断「打完过一局没有」用按局归档的 summary 目录——那里每局一份文件，比分内存计数可靠
 * （重启后仍然知道第一局打没打过）。
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { loadSettings } from '../settings'
import { logsDir } from '../logs/base-dir'
import { appendCappedJsonl } from '../logs/jsonl'
import { liveMatchId } from '../gsi-match'
import { gsiSummaryArchiveDir } from '../gsi-frames-summary'
import {
  shadowBlocks,
  shadowState,
  shadowView,
  summarizeShadow,
  type ShadowReport,
  type ShadowRow,
  type ShadowState,
  type ShadowView
} from '@shared/shadow-voice'

const SHADOW_LOG_MAX_BYTES = 256_000

export function shadowVoicePath(): string {
  return join(logsDir(), 'shadow-voice.jsonl')
}

/** 打完过几局：按局归档的 summary 每局一份文件，读目录就够，不去翻账本。 */
export function matchesSeen(): number {
  const dir = gsiSummaryArchiveDir()
  if (!existsSync(dir)) return 0
  try {
    return readdirSync(dir).filter((name) => name.endsWith('.json')).length
  } catch {
    return 0
  }
}

export function shadowStateNow(): ShadowState {
  return shadowState({ enabled: loadSettings().shadowFirstMatch, matchesSeen: matchesSeen() })
}

export function shadowActive(): boolean {
  return shadowBlocks(shadowStateNow())
}

export function shadowRows(): ShadowRow[] {
  const path = shadowVoicePath()
  if (!existsSync(path)) return []
  try {
    return readFileSync(path, 'utf8')
      .split(String.fromCharCode(10))
      .filter((line) => line.trim() !== '')
      .flatMap((line) => {
        try {
          const row = JSON.parse(line) as Partial<ShadowRow>
          if (typeof row.at !== 'string' || typeof row.text !== 'string') return []
          return [{ at: row.at, matchid: row.matchid ?? null, text: row.text }]
        } catch {
          return []
        }
      })
  } catch {
    return []
  }
}

export function shadowReport(): ShadowReport {
  return summarizeShadow(shadowRows())
}

export function shadowViewNow(): ShadowView {
  return shadowView(shadowStateNow(), shadowReport())
}

/**
 * 记下「本该念的这句」。
 *
 * 影子期间不合成、不按键，所以这里是唯一留下的证据；忘了记就等于什么都没发生，
 * 用户第一局打完既听不到声音也看不到对照。
 */
export function noteShadowLine(text: string): number {
  const clean = text.trim()
  if (clean === '') return 0
  const row: ShadowRow = { at: new Date().toISOString(), matchid: liveMatchId(), text: clean }
  appendCappedJsonl(shadowVoicePath(), { ...row }, SHADOW_LOG_MAX_BYTES)
  console.log('VOICE_OUT_SHADOW', JSON.stringify({ chars: clean.length, matchid: row.matchid }))
  return clean.length
}
