/**
 * 训练结束后从磁盘上的训练栈产物里取指标：ASR 读 trainer_state.json，GV 读 train.log 的 epoch 行。
 * 与「界面猜 stdout」相反——这里读的是训练框架自己写的文件，格式稳定。
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { pickLastCheckpointName } from '@shared/train/asr-ft'
import {
  compactMetricSeries,
  parseAsrTrainerState,
  parseGvTrainLog,
  type TrainRunMetrics
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
export function readAsrMetrics(runDir: string | undefined): TrainRunMetrics | null {
  if (!runDir) return null
  try {
    if (!existsSync(runDir)) return null
    const names = readdirSync(runDir).filter((name) => /^checkpoint-\d+$/.test(name))
    const last = pickLastCheckpointName(names)
    if (!last) return null
    const text = readTextIfExists(join(runDir, last, 'trainer_state.json'), 16 * 1024 * 1024)
    if (!text) return null
    return parseAsrTrainerState(JSON.parse(text))
  } catch {
    return null
  }
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
