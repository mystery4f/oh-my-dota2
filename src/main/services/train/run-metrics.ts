/**
 * 训练结束后从磁盘上的训练栈产物里取指标：ASR 读 trainer_state.json，GV 读 train.log 的 epoch 行。
 * 与「界面猜 stdout」相反——这里读的是训练框架自己写的文件，格式稳定。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { patchTrainRun } from './run-store'
import { join } from 'node:path'
import { pickLastCheckpointName } from '@shared/train/asr-ft'
import {
  compactMetricSeries,
  parseAsrTrainerState,
  parseFunasrTrainLog,
  parseGvTrainLog,
  type TrainRunMetrics,
  type TrainRunRecord
} from '@shared/train/run'

function readTextIfExists(file: string, maxBytes = 4 * 1024 * 1024): string | null {
  try {
    if (!existsSync(file)) return null
    if (statSync(file).size > maxBytes) return null
    return readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** ASR：runDir 下最后一个 checkpoint-* 里的 trainer_state.json。 */
/** ASR：先读最后一个 `checkpoint-*` 里的 trainer_state.json；没有就退回 FunASR 的 `outputs/<日>/<时>/train.log`。 */
export function readAsrMetrics(runDir: string | undefined): TrainRunMetrics | null {
  if (!runDir) return null
  try {
    if (!existsSync(runDir)) return null
    const names = readdirSync(runDir).filter((name) => /^checkpoint-\d+$/.test(name))
    const last = pickLastCheckpointName(names)
    if (last) {
      const text = readTextIfExists(join(runDir, last, 'trainer_state.json'), 16 * 1024 * 1024)
      if (text) return parseAsrTrainerState(JSON.parse(text))
    }
    const funasr = newestFunasrTrainLog(runDir)
    const log = funasr === null ? null : readTextIfExists(funasr, 32 * 1024 * 1024)
    return log === null ? null : parseFunasrTrainLog(log)
  } catch {
    return null
  }
}

/** FunASR 每个 hydra 任务在 `outputs/<date>/<time>/` 下写一份 train.log：取 mtime 最新的那份。 */
function newestFunasrTrainLog(runDir: string): string | null {
  const root = join(runDir, 'outputs')
  if (!existsSync(root)) return null
  let best: { file: string; mtime: number } | null = null
  for (const day of readdirSync(root)) {
    let times: string[] = []
    try {
      times = readdirSync(join(root, day))
    } catch {
      continue
    }
    for (const time of times) {
      const file = join(root, day, time, 'train.log')
      try {
        const { mtimeMs } = statSync(file)
        if (!best || mtimeMs > best.mtime) best = { file, mtime: mtimeMs }
      } catch {
        // 这一天没有训练日志
      }
    }
  }
  return best === null ? null : best.file
}

/** GV：logs/<exp>/train.log（webui 的目录布局；引擎包内还有一层 logs/ 的旧布局也认）。 */
export function readGvMetrics(home: string | undefined, exp: string): TrainRunMetrics | null {
  if (!home || !exp) return null
  const candidates = [join(home, 'GPT_SoVITS', 'logs', exp, 'train.log'), join(home, 'logs', exp, 'train.log')]
  for (const file of candidates) {
    const text = readTextIfExists(file)
    if (!text) continue
    const parsed = parseGvTrainLog(text)
    if (parsed.series.length === 0 && parsed.checkpoints.length === 0) continue
    return {
      steps: 0,
      epochs: parsed.epochs,
      bestLoss: null,
      lastLoss: null,
      series: compactMetricSeries(parsed.series)
    }
  }
  return null
}

/**
 * 老记录可能是 `metrics = null`（当时的解析器还不认 FunASR 的日志）：训练目录还在就趁现在补一次并存回库里，
 * 目录一被清盘就再也读不到了。只补最近几条，别为一次页面加载去翻几十份日志。
 */
export function backfillRunMetrics(runs: TrainRunRecord[], limit = 5): TrainRunRecord[] {
  let budget = limit
  return runs.map((run) => {
    if (run.metrics !== null || run.kind !== 'asr-ft' || !run.artifacts.runDir || budget <= 0) return run
    budget -= 1
    const metrics = readAsrMetrics(run.artifacts.runDir)
    if (metrics === null) return run
    patchTrainRun(run.id, (current) => ({ ...current, metrics }))
    return { ...run, metrics }
  })
}
