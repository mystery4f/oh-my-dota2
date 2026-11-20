import { buildFtDatasetEntries } from '@shared/train/dataset'
import { judgeDatasetHealth, type FtDatasetHealth, type HealthTakeInput } from '@shared/train/dataset-health'
import type { FtScriptGroup } from '@shared/train/recording'
import { ftRecList, ftRecPath, readFtScript } from './ft-record'
import { readWavFacts } from './wav-facts'

/** 体检的输入：一条录音的文字 + 磁盘上的 wav，加上稿子里应有的全部 key。 */
export interface HealthSource {
  takes: { key: string; text: string; wavPath: string }[]
  expected: string[]
}

/** 纯组装：把磁盘事实读成体检输入再交给判据（判据在 shared，探针与面板看到的永远是同一份）。 */
export function datasetHealthOf(source: HealthSource): FtDatasetHealth {
  const takes: HealthTakeInput[] = source.takes.map((take) => ({
    key: take.key,
    text: take.text,
    ...readWavFacts(take.wavPath)
  }))
  return judgeDatasetHealth({ takes, expected: source.expected })
}

/** 稿子里逐句组应有的 key（Gxx-Lnn）。自由说组没有稿子行，不算「缺句」。 */
export function expectedFtKeys(groups: readonly FtScriptGroup[]): string[] {
  const keys: string[] = []
  for (const group of groups) {
    if (group.mode === 'free') continue
    for (const line of group.lines) keys.push(`${group.id}-L${String(line.no).padStart(2, '0')}`)
  }
  return keys
}

/** 录音目录的指纹：条数与最新一条的 mtime。变了才重新读 wav（面板几秒轮询一次，不能每次都扫）。 */
function stampOf(recorded: readonly { key: string; mtimeMs: number }[]): string {
  return `${recorded.length}:${recorded.reduce((newest, info) => Math.max(newest, info.mtimeMs), 0)}`
}

let cache: { stamp: string; value: FtDatasetHealth } | null = null

/**
 * 当前录音的体检结果（带缓存）。
 * 稿子读不出来时给一份「没有条目」的体检而不是抛错：面板该照常渲染，说清楚「还没稿子」就够了。
 */
export async function currentFtDatasetHealth(): Promise<FtDatasetHealth> {
  const recorded = await ftRecList()
  const stamp = stampOf(recorded)
  if (cache?.stamp === stamp) return cache.value
  const script = await readFtScript()
  if (script.error || script.groups.length === 0) {
    const value = judgeDatasetHealth({ takes: [], expected: [] })
    cache = { stamp, value }
    return value
  }
  const recordedKeys = new Set(recorded.map((info) => info.key))
  const { entries } = buildFtDatasetEntries(
    script.groups,
    (group, line) => recordedKeys.has(`${group}-${line}`),
    (group, line) => ftRecPath(group, line)
  )
  const value = datasetHealthOf({ takes: entries, expected: expectedFtKeys(script.groups) })
  cache = { stamp, value }
  return value
}
