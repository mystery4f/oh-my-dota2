/**
 * 训练记录（run）纯缝：一次开训产生一条记录，跨进程重启仍可回看。
 * 只做形状与派生——落盘与读取在 main/services/train/run-store.ts。
 * 与 FtRunMeta 的分工：那是 ASR 训练目录里的账本（训练脚本的副产物），这里是指标层，两者互不替代。
 */
import type { TrainTaskKind } from './task'
import type { AsrFtMode } from './asr-ft'

export const TRAIN_RUN_STATUSES = ['running', 'trained', 'applied', 'failed', 'stopped'] as const
export type TrainRunStatus = (typeof TRAIN_RUN_STATUSES)[number]

export interface TrainRunParams {
  /** GV 引擎版本（v2ProPlus 等）；ASR 为空。 */
  version?: string
  batchSize?: number
  epochs?: number
  lr?: string
  /** 续训起点（checkpoint 名或 run id）；从头训为 null。 */
  resumeFrom?: string | null
  /** ASR 开训口径：从底模重训 / 接着上一轮的权重（记录里留一笔，事后分得清这轮吃的哪份底）。 */
  mode?: AsrFtMode
}

export interface TrainRunData {
  files: number
  /** 数据总时长；拿不到就 0，别编。 */
  durationMs: number
  bytes: number
}

export interface TrainRunPoint {
  step: number
  epoch?: number
  loss?: number
  lr?: number
}

export interface TrainRunMetrics {
  steps: number
  epochs: number
  bestLoss: number | null
  lastLoss: number | null
  /** 定长序列（≤ METRIC_SERIES_MAX），画折线用。 */
  series: TrainRunPoint[]
}

export interface TrainRunArtifacts {
  /** 训练目录（ASR 的 checkpoint 根，或 GV 的 config/日志根）。 */
  runDir?: string
  ckptDir?: string
  exportDir?: string
  /** 注册后的音色包名（GV 才有）。 */
  voicePack?: string
}

export interface TrainRunRecord {
  id: string
  kind: TrainTaskKind
  /** GV 实验名 / ASR 训练目录名。 */
  experiment: string
  params: TrainRunParams
  data: TrainRunData
  status: TrainRunStatus
  startedAt: number
  endedAt: number | null
  artifacts: TrainRunArtifacts
  metrics: TrainRunMetrics | null
  /** 是否已转正（ASR 应用 / GV 注册音色包）。 */
  applied: boolean
  error: string | null
}

/** 折线最多留这么多点：1400 step 全画既看不清也让 JSON 变大。 */
export const METRIC_SERIES_MAX = 200

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n)
}

/** 人类可读时间戳，也是 run id 的后半段：kind-yyyymmddHHmmss。 */
export function runStamp(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`
}

export function runIdFor(kind: TrainTaskKind, at: number): string {
  return `${kind}-${runStamp(at)}`
}

export function buildTrainRun(input: {
  kind: TrainTaskKind
  experiment: string
  params?: TrainRunParams
  data?: Partial<TrainRunData>
  startedAt?: number
  artifacts?: TrainRunArtifacts
}): TrainRunRecord {
  const startedAt = input.startedAt ?? Date.now()
  return {
    id: runIdFor(input.kind, startedAt),
    kind: input.kind,
    experiment: input.experiment,
    params: { ...input.params },
    data: { files: 0, durationMs: 0, bytes: 0, ...input.data },
    status: 'running',
    startedAt,
    endedAt: null,
    artifacts: { ...input.artifacts },
    metrics: null,
    applied: false,
    error: null
  }
}

/** 收场补写：终态、时间、指标、产物、错误。只合并传进来的字段，不覆盖已记录的值。 */
export function finishTrainRun(
  record: TrainRunRecord,
  patch: {
    status: Exclude<TrainRunStatus, 'running'>
    endedAt?: number
    metrics?: TrainRunMetrics | null
    artifacts?: TrainRunArtifacts
    error?: string | null
    applied?: boolean
  }
): TrainRunRecord {
  return {
    ...record,
    status: patch.status,
    endedAt: patch.endedAt ?? record.endedAt ?? Date.now(),
    metrics: patch.metrics === undefined ? record.metrics : patch.metrics,
    artifacts: { ...record.artifacts, ...patch.artifacts },
    error: patch.error === undefined ? record.error : patch.error,
    applied: patch.applied ?? record.applied
  }
}

export function isActiveRun(status: TrainRunStatus): boolean {
  return status === 'running'
}

/** 新的在前：列表默认顺序，读盘后也按这个排。 */
export function compareRunsDesc(a: TrainRunRecord, b: TrainRunRecord): number {
  return b.startedAt - a.startedAt
}

export function runElapsedMs(run: TrainRunRecord, now = Date.now()): number {
  return Math.max(0, (run.endedAt ?? now) - run.startedAt)
}

/** 等距抽样但保住首尾：折线要能看出起点和终点，均匀抽会丢掉最后一个。 */
export function compactMetricSeries(points: readonly TrainRunPoint[], max = METRIC_SERIES_MAX): TrainRunPoint[] {
  if (points.length <= max) return points.map((p) => ({ ...p }))
  if (max < 3) return points.slice(-max).map((p) => ({ ...p }))
  const out: TrainRunPoint[] = [{ ...points[0] }]
  const inner = max - 2
  const stride = (points.length - 2) / inner
  for (let i = 1; i <= inner; i++) {
    const idx = Math.round(i * stride)
    const point = points[idx]
    if (point) out.push({ ...point })
  }
  out.push({ ...points[points.length - 1] })
  return out
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

/**
 * ASR trainer_state.json → 指标。log_history 的每条是 {epoch, learning_rate?, loss?, step}，
 * eval 行也混在里面（只带 eval_loss），按 loss 是否存在过滤。
 */
export function parseAsrTrainerState(json: unknown): TrainRunMetrics | null {
  const history =
    typeof json === 'object' && json !== null && Array.isArray((json as { log_history?: unknown }).log_history)
      ? ((json as { log_history: unknown[] }).log_history)
      : null
  if (!history) return null
  const points: TrainRunPoint[] = []
  let bestLoss: number | null = null
  let lastLoss: number | null = null
  let steps = 0
  let epochs = 0
  for (const raw of history) {
    if (typeof raw !== 'object' || raw === null) continue
    const row = raw as Record<string, unknown>
    const step = asNumber(row.step)
    const loss = asNumber(row.loss)
    const epoch = asNumber(row.epoch)
    const lr = asNumber(row.learning_rate)
    if (step !== undefined) steps = Math.max(steps, step)
    if (epoch !== undefined) epochs = Math.max(epochs, Math.ceil(epoch))
    if (loss === undefined) continue
    lastLoss = loss
    if (bestLoss === null || loss < bestLoss) bestLoss = loss
    points.push({ step: step ?? points.length + 1, epoch, loss, lr })
  }
  if (points.length === 0) return null
  return { steps, epochs, bestLoss, lastLoss, series: compactMetricSeries(points) }
}

/** GV train.log：只有 epoch 边界与存档成功两种行（loss 在 tfevents 里，本版不读）。 */
export function parseGvTrainLog(text: string): { epochs: number; checkpoints: string[]; series: TrainRunPoint[] } {
  let epochs = 0
  const checkpoints: string[] = []
  const series: TrainRunPoint[] = []
  for (const raw of text.split(/\r?\n/)) {
    const epochHit = /====>\s*Epoch:\s*(\d+)/.exec(raw)
    if (epochHit) {
      epochs = Math.max(epochs, Number(epochHit[1]))
      series.push({ step: series.length + 1, epoch: Number(epochHit[1]) })
      continue
    }
    const ckptHit = /saving ckpt\s+(\S+?):Success/.exec(raw)
    if (ckptHit) checkpoints.push(ckptHit[1])
  }
  return { epochs, checkpoints, series: compactMetricSeries(series) }
}

/**
 * FunASR 的 train.log（`outputs/<date>/<time>/train.log`）：每步一行 train、每轮两行 val。
 * paraformer 不写 trainer_state.json，这是它唯一的指标来源。
 * 行格式：`[时间][root][INFO] - train, rank: 0, epoch: 0/15, …, total step: 1, (loss_avg_epoch: 2.028), …`
 */
export function parseFunasrTrainLog(text: string): TrainRunMetrics | null {
  const points: TrainRunPoint[] = []
  let steps = 0
  let epochs = 0
  let lastTrainLoss: number | null = null
  let bestValLoss: number | null = null
  let lastValLoss: number | null = null
  for (const raw of text.split(/\r?\n/)) {
    const hit =
      /^\[[^\]]+\]\[root\]\[INFO\] - (train|val), rank: \d+, epoch: (\d+)\/(\d+),.*?\(loss_avg_epoch: (-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)\)/.exec(
        raw
      )
    if (!hit) continue
    const loss = Number(hit[4])
    if (!Number.isFinite(loss)) continue
    const stepHit = /total step: (\d+)/.exec(raw)
    const step = stepHit ? Number(stepHit[1]) : points.length + 1
    steps = Math.max(steps, step)
    epochs = Math.max(epochs, Number(hit[3]))
    points.push({ step, epoch: Number(hit[2]), loss })
    if (hit[1] === 'val') {
      lastValLoss = loss
      if (bestValLoss === null || loss < bestValLoss) bestValLoss = loss
    } else {
      lastTrainLoss = loss
    }
  }
  if (points.length === 0) return null
  return {
    steps,
    epochs,
    bestLoss: bestValLoss ?? lastTrainLoss,
    lastLoss: lastValLoss ?? lastTrainLoss,
    series: compactMetricSeries(points)
  }
}

const RUN_STATUS_LABELS: Record<TrainRunStatus, string> = {
  running: '进行中',
  trained: '已训练',
  applied: '已应用',
  failed: '失败',
  stopped: '已停止'
}

export function runStatusLabel(status: TrainRunStatus): string {
  return RUN_STATUS_LABELS[status]
}

const RUN_KIND_LABELS: Record<TrainTaskKind, string> = {
  demo: '演示',
  'asr-ft': '识别微调',
  'gv-gpt': '音色 GPT 腿',
  'gv-sovits': '音色 SoVITS 腿'
}

export function runKindLabel(kind: TrainTaskKind): string {
  return RUN_KIND_LABELS[kind]
}
