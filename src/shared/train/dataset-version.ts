/**
 * 一组录音的版本号（#109）。
 *
 * 训练记录以前只能靠 `runs.packed_ledger` 里那份冻结快照回答「这一行吃的是哪些录音」，
 * 但那是一整份 JSON，人看不出两次训练是不是同一批数据，也没法在录音目录变了之后一眼判断
 * 「现在目录里的还是不是那一版」。
 *
 * 这里的版本号只由**内容**决定：每一行是 `key + 文本 + 字节数`，排序后取 FNV-1a。
 * 文件名、mtime、录音顺序都不进哈希——换个盘符、重新录一遍同样内容，版本号不变；
 * 改一个字、补一条 take，版本号就变。老行没有版本号就明确说「早于版本号」，绝不猜。
 */

export const DATASET_VERSION_PREFIX = 'ds1-'

/** 参与版本号的最小事实：一段录音的身份、它被朗读的文本、它的字节数。 */
export interface DatasetVersionInput {
  key: string
  text: string
  bytes: number
}

/** 一个版本的完整描述：版本号 + 它覆盖多少条、多少字节。 */
export interface DatasetVersionFact {
  version: string
  takes: number
  bytes: number
}

function fnv1a(seed: number, text: string): number {
  let hash = seed
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function hex8(value: number): string {
  return value.toString(16).padStart(8, '0')
}

/** 内容指纹：空集合也有确定的版本号（`ds1-00000000` 那一类，而不是空字符串）。 */
export function datasetVersionOf(entries: readonly DatasetVersionInput[]): string {
  const rows = entries.map((entry) => `${entry.key}\u0000${entry.text}\u0000${entry.bytes}`).sort()
  const a = fnv1a(0x811c9dc5, rows.join('\u0001'))
  const b = fnv1a(0x811c9dc5 ^ rows.length, rows.slice().reverse().join('\u0001'))
  return `${DATASET_VERSION_PREFIX}${hex8(a)}${hex8(b)}`
}

export function datasetVersionFact(entries: readonly DatasetVersionInput[]): DatasetVersionFact {
  let bytes = 0
  for (const entry of entries) bytes += Number.isFinite(entry.bytes) ? entry.bytes : 0
  return { version: datasetVersionOf(entries), takes: entries.length, bytes }
}

function megabytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${Math.round(bytes / (1024 * 1024) * 10) / 10} MB`
}

/** 人读的一行：`27 条 · 243.1 MB · ds1-ab12cd34ef56ab78`。 */
export function datasetVersionLine(fact: DatasetVersionFact): string {
  return `${fact.takes} 条 · ${megabytes(fact.bytes)} · ${fact.version}`
}

/** 一行训练记录与「现在录音目录里的那一版」比对。 */
export type DatasetVersionDelta = 'same' | 'different' | 'unknown'

export function datasetVersionDelta(
  runVersion: string | null | undefined,
  currentVersion: string | null | undefined
): DatasetVersionDelta {
  if (runVersion === null || runVersion === undefined || runVersion === '') return 'unknown'
  if (currentVersion === null || currentVersion === undefined || currentVersion === '') return 'unknown'
  return runVersion === currentVersion ? 'same' : 'different'
}

/**
 * 比对结果一句话。`unknown` 不猜：老行确实没这个字段，硬凑一个版本号会让「这一行训的是哪批数据」
 * 重新变成传说。
 */
export function datasetVersionDiffLine(
  runVersion: string | null | undefined,
  currentVersion: string | null | undefined
): string {
  const delta = datasetVersionDelta(runVersion, currentVersion)
  if (delta === 'unknown') return '这一行早于版本号，只能靠冻结的打包快照对账'
  if (delta === 'same') return `训练用的就是现在这一版（${String(runVersion)}）`
  return `训练用的是 ${String(runVersion)}，现在目录已是 ${String(currentVersion)}（之后加过或改过 take）`
}
