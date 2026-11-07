/**
 * 训练记录落盘：一条 run 一个 JSON 文件，写入走临时文件 + rename（断电只丢最后一条，不留半个文件）。
 * 目录在便携数据目录下的 train-runs/，与 ASR 的 run 目录、GV 的实验目录分开——那边是产物，这边是索引。
 */
import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareRunsDesc, type TrainRunRecord, type TrainRunStatus } from '@shared/train/run'

/** 只留最近这么多条：一条 JSON 几百字节到几十 KB，多到上千条才会明显占盘。 */
export const TRAIN_RUN_KEEP = 200

const STATUSES: readonly TrainRunStatus[] = ['running', 'trained', 'applied', 'failed', 'stopped']

export function trainRunsDir(): string {
  return join(app.getPath('userData'), 'train-runs')
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** 容错解析：字段缺就补默认，类型不对就整条丢掉（旧版本文件不该让列表炸掉）。 */
function normalizeRun(value: unknown): TrainRunRecord | null {
  if (!isRecord(value)) return null
  const id = typeof value.id === 'string' ? value.id : ''
  const kind = typeof value.kind === 'string' ? value.kind : ''
  const status = value.status
  if (!id || !kind) return null
  if (typeof status !== 'string' || !STATUSES.includes(status as TrainRunStatus)) return null
  const data = isRecord(value.data) ? value.data : {}
  return {
    id,
    kind: kind as TrainRunRecord['kind'],
    experiment: typeof value.experiment === 'string' ? value.experiment : '',
    params: isRecord(value.params) ? (value.params as TrainRunRecord['params']) : {},
    data: {
      files: typeof data.files === 'number' ? data.files : 0,
      durationMs: typeof data.durationMs === 'number' ? data.durationMs : 0,
      bytes: typeof data.bytes === 'number' ? data.bytes : 0
    },
    status: status as TrainRunStatus,
    startedAt: typeof value.startedAt === 'number' ? value.startedAt : 0,
    endedAt: typeof value.endedAt === 'number' ? value.endedAt : null,
    artifacts: isRecord(value.artifacts) ? (value.artifacts as TrainRunRecord['artifacts']) : {},
    metrics: isRecord(value.metrics) ? (value.metrics as unknown as TrainRunRecord['metrics']) : null,
    applied: value.applied === true,
    error: typeof value.error === 'string' ? value.error : null
  }
}

export function saveTrainRun(run: TrainRunRecord): void {
  try {
    const dir = trainRunsDir()
    mkdirSync(dir, { recursive: true })
    const target = join(dir, `${run.id}.json`)
    const tmp = `${target}.tmp`
    writeFileSync(tmp, JSON.stringify(run, null, 2), 'utf8')
    renameSync(tmp, target)
  } catch {
    // 记录失败不能拖垮训练本身：日志里会留痕，列表少一条可以接受。
  }
}

export function loadTrainRun(id: string): TrainRunRecord | null {
  try {
    const file = join(trainRunsDir(), `${id}.json`)
    if (!existsSync(file)) return null
    return normalizeRun(JSON.parse(readFileSync(file, 'utf8')))
  } catch {
    return null
  }
}

export function listTrainRuns(): TrainRunRecord[] {
  try {
    const dir = trainRunsDir()
    if (!existsSync(dir)) return []
    const runs: TrainRunRecord[] = []
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      const run = loadTrainRun(name.slice(0, -'.json'.length))
      if (run) runs.push(run)
    }
    return runs.sort(compareRunsDesc)
  } catch {
    return []
  }
}

/** 读改写一次：manager 收场时补指标与产物，找不到记录就跳过。 */
export function patchTrainRun(id: string, patch: (run: TrainRunRecord) => TrainRunRecord): TrainRunRecord | null {
  const current = loadTrainRun(id)
  if (!current) return null
  const next = patch(current)
  saveTrainRun(next)
  return next
}

export function deleteTrainRun(id: string): void {
  try {
    unlinkSync(join(trainRunsDir(), `${id}.json`))
  } catch {
    // 不存在就当删掉了
  }
}

/** 启动时清一次：只留最近 keep 条，避免多年积累的索引拖慢列表。 */
export function pruneTrainRuns(keep = TRAIN_RUN_KEEP): number {
  const runs = listTrainRuns()
  if (runs.length <= keep) return 0
  const dropped = runs.slice(keep)
  for (const run of dropped) deleteTrainRun(run.id)
  return dropped.length
}
