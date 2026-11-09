import { app } from 'electron'
import { readdirSync, rmSync, statSync, type Dirent } from 'node:fs'
import { join } from 'node:path'
import { ASR_ENGINES } from '@shared/asr/engines'
import { finishTrainRun, type TrainRunRecord } from '@shared/train/run'
import { asrModelsRoot } from './asr-ft'
import { listTrainRuns, patchTrainRun, saveTrainRun } from './run-store'

/**
 * 启动对账：把「上一次进程没跑完」留下的痕迹收干净。只在启动时做一次。
 *
 * 收四样东西，都是训练被打断才留得下的：
 * - 库里 `running` 的行不会自己变成终态。留着它，面板会一直显示「训练中」，
 *   开始训练的按钮永远灰着，而那个进程早就不在了。
 * - `<模型目录>.next` 是训练前抄进去的接续权重或导出产物。没有导出产物 = 纯垃圾
 *   （一次增量 4.4 GB），删；有导出产物 = 导出跑完、换模前那一刻退出，留下不碰。
 * - `asr-ft-onnx/` 里的导出产物每轮一份（约 7.2 GB），只留最新那份齐全的，其余连半成品删。
 * - 中断轮的 run 目录只留最新那份还能接着训的，其余删（`pruneAsrFtRunDirs()` 只在换模成功时收）。
 */
export interface TrainReconcileResult {
  failedRuns: string[]
  removedDirs: string[]
  keptDirs: string[]
  /** 删掉的导出产物目录（`asr-ft-onnx/`）。 */
  removedExports: string[]
  /** 删掉的中断轮 run 目录。 */
  removedRunDirs: string[]
}

const EXPORT_ARTIFACT_NAMES = Object.values(ASR_ENGINES)
  .flatMap((engine) => engine.finetune?.artifacts.map((item) => item.from) ?? [])
  .filter((name, index, all) => all.indexOf(name) === index)

/** 递归求大小：接续目录里躺着的是一个 checkpoint 子目录，只看顶层会记成 0 字节。 */
function dirBytes(dir: string): number {
  let entries: Dirent[]
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  return entries.reduce((sum, entry) => {
    const path = join(dir, String(entry.name))
    if (entry.isDirectory()) return sum + dirBytes(path)
    if (!entry.isFile()) return sum
    try {
      return sum + statSync(path).size
    } catch {
      return sum
    }
  }, 0)
}

/** `.next` 里有没有一件导出产物：有就说明这是「等换模」的成品，不是接续用的中间件。 */
function holdsExport(dir: string): boolean {
  try {
    const names = readdirSync(dir)
    return EXPORT_ARTIFACT_NAMES.some((name) => names.includes(name))
  } catch {
    return false
  }
}

function staleRuns(): string[] {
  const failed: string[] = []
  for (const run of listTrainRuns()) {
    if (run.status !== 'running') continue
    const saved: TrainRunRecord = finishTrainRun(run, {
      status: 'failed',
      error: '上次训练时应用退出了，这一轮没有跑完',
      metrics: run.metrics
    })
    saveTrainRun(saved)
    failed.push(run.id)
  }
  return failed
}

function sweepStagingDirs(): { removed: string[]; kept: string[] } {
  const root = asrModelsRoot()
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return { removed: [], kept: [] }
  }
  const removed: string[] = []
  const kept: string[] = []
  for (const name of entries) {
    if (!name.endsWith('.next')) continue
    const dir = join(root, name)
    if (holdsExport(dir)) {
      kept.push(name)
      continue
    }
    const bytes = dirBytes(dir)
    try {
      rmSync(dir, { recursive: true, force: true })
      removed.push(name)
      console.log('TRAIN_RECONCILE_NEXT_REMOVED', name, bytes)
    } catch (err) {
      console.log('TRAIN_RECONCILE_NEXT_FAILED', name, String(err))
    }
  }
  return { removed, kept }
}

/** 只列子目录名：导出目录与 run 目录都按名字排序决定留谁。 */
function subdirs(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => String(entry.name))
  } catch {
    return []
  }
}

/**
 * 导出产物目录：只留最新那份产物齐全的（`lastExportDir()` 认的就是它），其余连半成品一起删。
 * 一份 7.2 GB，而它随时能从 run 目录重导；半成品是导出腿被杀留下的，谁也读不了。
 */
function sweepExportDirs(): string[] {
  const root = join(app.getPath('userData'), 'asr-ft-onnx')
  const names = subdirs(root)
  const ready = names.filter((name) => holdsExport(join(root, name))).sort()
  const keep = ready.length > 0 ? ready[ready.length - 1] : null
  const removed: string[] = []
  for (const name of names) {
    if (name === keep) continue
    const dir = join(root, name)
    const bytes = dirBytes(dir)
    try {
      rmSync(dir, { recursive: true, force: true })
      removed.push(name)
      console.log('TRAIN_RECONCILE_EXPORT_REMOVED', name, bytes)
    } catch (err) {
      console.log('TRAIN_RECONCILE_EXPORT_FAILED', name, String(err))
    }
  }
  return removed
}

/** 还能接着训的痕迹：qwen3 认 checkpoint-N，funasr 认 model.pt*（`findIncrementalSource` 认的就是这两样）。 */
function holdsResumeWeight(dir: string): boolean {
  try {
    return readdirSync(dir, { withFileTypes: true }).some(
      (entry) =>
        (entry.isDirectory() && /^checkpoint-\d+$/.test(String(entry.name))) ||
        (entry.isFile() && /^model\.pt(\..*)?$/.test(String(entry.name)))
    )
  } catch {
    return false
  }
}

/**
 * 中断/失败轮的 run 目录：只留最新那份还能接着训的（下一轮的增量起点），其余删。
 * `pruneAsrFtRunDirs()` 只在换模成功时跑，而中断的那几轮永远等不到下一次成功，
 * 一份 4.4 GB 会一直躺着——实测 2026-11-09 积了两份。
 */
function sweepRunDirs(): string[] {
  const removed: string[] = []
  let keptSource = false
  for (const run of listTrainRuns()) {
    const dir = run.artifacts.runDir
    if (!dir || run.status === 'running') continue
    if (!keptSource && holdsResumeWeight(dir)) {
      keptSource = true
      console.log('TRAIN_RECONCILE_RUN_DIR_KEPT', run.id, dir)
      continue
    }
    const bytes = dirBytes(dir)
    try {
      rmSync(dir, { recursive: true, force: true })
      patchTrainRun(run.id, (item) => ({ ...item, artifacts: { ...item.artifacts, runDir: undefined } }))
      removed.push(dir)
      console.log('TRAIN_RECONCILE_RUN_DIR_REMOVED', run.id, bytes)
    } catch (err) {
      console.log('TRAIN_RECONCILE_RUN_DIR_FAILED', run.id, String(err))
    }
  }
  return removed
}

/** 幂等：没有痕迹时什么也不做，返回五个空数组。 */
export function reconcileTrainState(): TrainReconcileResult {
  const failed = staleRuns()
  for (const id of failed) console.log('TRAIN_RECONCILE_RUN_FAILED', id)
  const { removed, kept } = sweepStagingDirs()
  for (const name of kept) console.log('TRAIN_RECONCILE_NEXT_KEPT', join(app.getPath('userData'), 'asr-models', name))
  const removedExports = sweepExportDirs()
  const removedRunDirs = sweepRunDirs()
  return { failedRuns: failed, removedDirs: removed, keptDirs: kept, removedExports, removedRunDirs }
}
