/**
 * 试听对比的主进程一半：把同一批留出集录音喂给两副模型，转写函数可注入。
 *
 * 转写默认走 sherpa worker（`sherpaTranscribe`），与正式识别同一套引擎、同一份词表；
 * 探针注入假转写，于是「两副模型看到的是同一批录音」这条验收不依赖任何真模型。
 * 任何一侧转写失败都按空串算（全错），不丢句——丢句会把失败藏成「一样」。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { judgeAudition, type AuditionPair, type FtAudition } from '@shared/train/audition'
import { ASR_ENGINES } from '@shared/asr/engines'
import type { AsrEngineId } from '@shared/asr/engines'
import type { FtLedgerEntry } from '@shared/train/asr-ft'
import { sherpaTranscribe } from '../voice/sherpa-asr'

/** 一侧的转写：给模型目录与 wav，回一段文字（失败给 null，调用方当空串）。 */
export type AuditionTranscribe = (modelDir: string, wavPath: string) => Promise<string | null>

/** 真实转写：与正式识别同一个 worker，只是模型目录由调用方指定（转正前后各一份）。 */
export function defaultAuditionTranscribe(engineId: AsrEngineId): AuditionTranscribe {
  const spec = ASR_ENGINES[engineId]
  return async (modelDir: string, wavPath: string): Promise<string | null> => {
    if (!existsSync(join(modelDir)) || !existsSync(wavPath)) return null
    const result = await sherpaTranscribe({ kind: spec.sherpaKind, dir: modelDir, wav: wavPath, hotwords: '' })
    return result === null ? null : result.text
  }
}

/** 从账本里挑留出集：只认 eval 行，且录音文件还在（被清理掉的句子听不了）。 */
export function auditionEntriesOf(ledger: readonly FtLedgerEntry[]): FtLedgerEntry[] {
  return ledger.filter((entry) => entry.split === 'eval' && entry.text.trim() !== '' && existsSync(entry.wavPath))
}

/** 两侧都跑一遍，得到并排的输入对（这一步之后才轮到纯缝判好坏）。 */
export async function collectAuditionPairs(
  entries: readonly FtLedgerEntry[],
  dirs: { before: string; after: string },
  transcribe: AuditionTranscribe
): Promise<AuditionPair[]> {
  const pairs: AuditionPair[] = []
  for (const entry of entries) {
    const before = (await transcribe(dirs.before, entry.wavPath)) ?? ''
    const after = (await transcribe(dirs.after, entry.wavPath)) ?? ''
    pairs.push({ key: entry.key, expected: entry.text, before, after })
  }
  return pairs
}

/** 一次完整试听：同一批 entries 喂两副模型，返回落库用的结论。 */
export async function auditionModelPair(
  entries: readonly FtLedgerEntry[],
  dirs: { before: string; after: string },
  transcribe: AuditionTranscribe,
  at = Date.now()
): Promise<FtAudition> {
  const pairs = await collectAuditionPairs(entries, dirs, transcribe)
  return judgeAudition(pairs, at)
}
