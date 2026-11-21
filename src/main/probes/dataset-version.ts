/**
 * #109 数据集版本号的探针。
 *
 * 票面验收：`a run row resolves to the exact recording set it trained on, even after later takes are added`。
 * 所以这里不只验纯函数：最后一段真的开一个临时 `runs.db`，写入一版录音 → 落一行 run →
 * 再加一条 take → 断言「旧行仍指向它训练的那一版」，而「现在目录里的版本」变了。
 */
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DATASET_VERSION_PREFIX,
  datasetVersionDelta,
  datasetVersionDiffLine,
  datasetVersionFact,
  datasetVersionLine,
  datasetVersionOf,
  type DatasetVersionInput
} from '@shared/train/dataset-version'
import { buildTrainRun } from '@shared/train/run'
import {
  currentDatasetVersion,
  datasetVersionForRun,
  listDatasetEntries,
  releaseTrainDatabaseForProbe,
  saveDatasetLedger,
  saveTrainRun,
  useTrainDatabase
} from '../services/train/run-store'
import { finishProbe, probeCases } from './harness'

function entry(key: string, text: string, bytes: number): DatasetVersionInput {
  return { key, text, bytes }
}


export async function runDatasetVersionProbe(): Promise<void> {
  const { cases, push } = probeCases()

  // —— 纯函数：内容决定版本号 ——
  const setA = [entry('G14-L01', '中路不见了', 32000), entry('G14-L02', '上路要人来', 24000)]
  const setReordered = [setA[1], setA[0]]
  push('同一组录音取两次版本号相同', datasetVersionOf(setA) === datasetVersionOf(setA), datasetVersionOf(setA))
  push(
    '录音顺序不影响版本号',
    datasetVersionOf(setA) === datasetVersionOf(setReordered),
    datasetVersionOf(setReordered)
  )
  push(
    '加一条 take 版本号就变',
    datasetVersionOf([...setA, entry('G14-L03', '买活好了', 16000)]) !== datasetVersionOf(setA),
    datasetVersionOf([...setA, entry('G14-L03', '买活好了', 16000)])
  )
  push(
    '改一条的文本版本号就变',
    datasetVersionOf([entry('G14-L01', '中路不见了！', 32000), setA[1]]) !== datasetVersionOf(setA),
    datasetVersionOf([entry('G14-L01', '中路不见了！', 32000), setA[1]])
  )
  push(
    '只改字节数也算新版本',
    datasetVersionOf([entry('G14-L01', '中路不见了', 32001), setA[1]]) !== datasetVersionOf(setA),
    datasetVersionOf([entry('G14-L01', '中路不见了', 32001), setA[1]])
  )
  push(
    '空集合也有稳定版本号，不是空串',
    datasetVersionOf([]) === datasetVersionOf([]) && datasetVersionOf([]).startsWith(DATASET_VERSION_PREFIX),
    datasetVersionOf([])
  )
  const fact = datasetVersionFact(setA)
  push(
    '描述带上条数与字节数',
    fact.takes === 2 && fact.bytes === 56000 && datasetVersionLine(fact).includes('2 条'),
    datasetVersionLine(fact)
  )

  // —— 比对：same / different / unknown 三态，unknown 不许猜 ——
  push(
    '版本相同判 same，不同判 different',
    datasetVersionDelta('ds1-a', 'ds1-a') === 'same' &&
      datasetVersionDelta('ds1-a', 'ds1-b') === 'different',
    `${datasetVersionDelta('ds1-a', 'ds1-a')} / ${datasetVersionDelta('ds1-a', 'ds1-b')}`
  )
  push(
    '老行没有版本号判 unknown（不是 same）',
    datasetVersionDelta(null, 'ds1-b') === 'unknown' &&
      datasetVersionDelta('', 'ds1-b') === 'unknown' &&
      datasetVersionDelta('ds1-a', null) === 'unknown',
    `${datasetVersionDelta(null, 'ds1-b')} / ${datasetVersionDelta('', 'ds1-b')} / ${datasetVersionDelta('ds1-a', null)}`
  )
  push(
    'unknown 的文案说的是「早于版本号」，不伪造一个',
    datasetVersionDiffLine(null, 'ds1-b').includes('早于版本号') &&
      datasetVersionDiffLine('ds1-a', 'ds1-a').includes('就是现在这一版') &&
      datasetVersionDiffLine('ds1-a', 'ds1-b').includes('之后加过或改过 take'),
    datasetVersionDiffLine(null, 'ds1-b')
  )

  // —— 契约：run 行默认带 null，收场补写能盖掉 ——
  const fresh = buildTrainRun({ kind: 'asr-ft', experiment: 'ft', startedAt: 1_700_000_000_000 })
  push('新 run 默认没有版本号字段内容', fresh.datasetVersion === null, String(fresh.datasetVersion))
  const stamped = buildTrainRun({
    kind: 'asr-ft',
    experiment: 'ft',
    startedAt: 1_700_000_000_000,
    datasetVersion: datasetVersionOf(setA)
  })
  push('开训就能把版本号写进 run 行', stamped.datasetVersion === datasetVersionOf(setA), String(stamped.datasetVersion))

  // —— 落库：临时 runs.db 里走一遍「先训练，后加 take」 ——
  const dir = mkdtempSync(join(tmpdir(), 'omd-dsver-'))
  try {
    useTrainDatabase(join(dir, 'runs.db'))
    const ledgerV1 = [
      { key: 'G14-L01', wavPath: join(dir, 'G14-L01.wav'), bytes: 32000, mtimeMs: 1, text: '中路不见了', split: 'train' as const },
      { key: 'G14-L02', wavPath: join(dir, 'G14-L02.wav'), bytes: 24000, mtimeMs: 1, text: '上路要人来', split: 'eval' as const }
    ]
    saveDatasetLedger(ledgerV1, 'run-v1')
    const versionV1 = currentDatasetVersion()
    const run = buildTrainRun({
      kind: 'asr-ft',
      experiment: 'ft',
      startedAt: 1_700_000_000_000,
      datasetVersion: versionV1
    })
    saveTrainRun(run)
    push(
      '版本号写进 runs.db 并原样读回',
      datasetVersionForRun(run.id) === versionV1,
      String(datasetVersionForRun(run.id))
    )

    // 之后又录了一条 —— 目录变了，旧行不能跟着变。
    saveDatasetLedger(
      [...ledgerV1, { key: 'G14-L03', wavPath: join(dir, 'G14-L03.wav'), bytes: 16000, mtimeMs: 2, text: '买活好了', split: 'train' as const }],
      'run-v1'
    )
    const versionV2 = currentDatasetVersion()
    push('后加的 take 让「现在这一版」变了', versionV2 !== versionV1, `${versionV1} -> ${versionV2}`)
    push(
      '旧 run 行仍指向它训练的那一版',
      datasetVersionForRun(run.id) === versionV1 && datasetVersionDelta(datasetVersionForRun(run.id), versionV2) === 'different',
      datasetVersionDiffLine(datasetVersionForRun(run.id), versionV2)
    )

    // 老行（补列之前写的）：没有版本号，读回 null，文案说「早于版本号」。
    const legacy = { ...buildTrainRun({ kind: 'asr-ft', experiment: 'old', startedAt: 1_600_000_000_000 }), datasetVersion: null }
    saveTrainRun(legacy)
    push(
      '老行读回 null，并明确说「早于版本号」',
      datasetVersionForRun(legacy.id) === null && datasetVersionDiffLine(datasetVersionForRun(legacy.id), versionV2).includes('早于版本号'),
      String(datasetVersionForRun(legacy.id))
    )
    push(
      '账本能读出这两条 take 之外的第三条，说明目录确实变了',
      listDatasetEntries().length === 3,
      `entries=${listDatasetEntries().length}`
    )
  } finally {
    releaseTrainDatabaseForProbe()
    rmSync(dir, { recursive: true, force: true })
  }

  finishProbe('DATASET_VERSION_PROBE', cases)
}
