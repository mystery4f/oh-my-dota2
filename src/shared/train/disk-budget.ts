/**
 * #108：开训前的磁盘预算。
 *
 * 为什么要有这一层：一次 asr-ft 的 run 目录大约 15 GB，而 `pruneAsrFtRunDirs` 只在换模成功之后才清盘
 * （见 `docs/adr/asr-ft-run-retention.md`）。所以「盘不够」这件事必须**在开跑前**说清楚：
 * 跑到一半磁盘满，用户看到的是训练失败，而真正的原因是一个小时后才想得起来的空间。
 *
 * 估算刻意保守、也刻意说清来源：权重按三份算（训练检查点 + 平均后的权重 + 导出的 ONNX），
 * 再加这批录音本身；留 30% 余量给 `.next` 暂存和日志。票面要求「估算落在与实测的既定区间内」，
 * 这个区间就写在这里（`TRAIN_ESTIMATE_BAND`），不许在别处再写一个数。
 */

/** 3 = 训练检查点 + 平均权重 + 导出 ONNX：这三份会同时留在 run 目录与模型目录里。 */
export const TRAIN_CHECKPOINT_COPIES = 3

/** 余量：`.next` 暂存、日志、导出中间产物。 */
export const TRAIN_HEADROOM = 0.3

/** 估算与实测的允许偏差（±50%）：超过这个范围就是估算方法失效，不是「差不多」。 */
export const TRAIN_ESTIMATE_BAND = 0.5

const GB = 1024 ** 3

export interface TrainFootprintInput {
  /** 当前模型权重目录的字节数（`measureDirBytes` 量的那个）。 */
  weightsBytes: number
  /** 这批训练录音的字节数（账本里每条 `bytes` 相加）。 */
  datasetBytes: number
}

export interface DiskBudget {
  ok: boolean
  /** 估算的运行占用（未含余量）。 */
  estimateBytes: number
  /** 实际需要的可用空间（含余量）。 */
  needBytes: number
  freeBytes: number
  /** 一句话：够跑 / 不够，两句都必须带数字。 */
  line: string
}

/** 一次训练大概占多少：权重三份 + 这批录音。负数字段一律当 0，估算不许变得更乐观。 */
export function estimateTrainFootprint(input: TrainFootprintInput): number {
  const weights = Number.isFinite(input.weightsBytes) ? Math.max(0, input.weightsBytes) : 0
  const dataset = Number.isFinite(input.datasetBytes) ? Math.max(0, input.datasetBytes) : 0
  return weights * TRAIN_CHECKPOINT_COPIES + dataset
}

/** 人类可读的 GB，一位小数：面板与日志共用同一句话。 */
export function formatGb(bytes: number): string {
  const value = Number.isFinite(bytes) ? Math.max(0, bytes) : 0
  return `${(value / GB).toFixed(1)} GB`
}

/**
 * 判断磁盘够不够。不够就**拒绝开跑**并带上两个数字：要多少、现在剩多少——
 * 「空间不足」这种没有数字的说法，用户没法据此清盘。
 */
export function judgeDiskBudget(input: { estimateBytes: number; freeBytes: number }): DiskBudget {
  const estimate = Math.max(0, Number.isFinite(input.estimateBytes) ? input.estimateBytes : 0)
  const free = Math.max(0, Number.isFinite(input.freeBytes) ? input.freeBytes : 0)
  const need = Math.ceil(estimate * (1 + TRAIN_HEADROOM))
  const ok = free >= need
  return {
    ok,
    estimateBytes: estimate,
    needBytes: need,
    freeBytes: free,
    line: ok
      ? `这一轮大概占 ${formatGb(estimate)}（权重 ${TRAIN_CHECKPOINT_COPIES} 份 + 录音），留余量要 ${formatGb(need)}，当前可用 ${formatGb(free)}`
      : `磁盘不够：这一轮要 ${formatGb(need)}（估算 ${formatGb(estimate)} + 30% 余量），当前只剩 ${formatGb(free)} —— 先清掉旧的 asr-ft-runs 再开训`
  }
}

/** 估算是否落在与实测的既定区间内（±`TRAIN_ESTIMATE_BAND`）。探针与日志共用这一条。 */
export function estimateWithinBand(estimateBytes: number, actualBytes: number): boolean {
  if (actualBytes <= 0) return false
  return Math.abs(estimateBytes - actualBytes) / actualBytes <= TRAIN_ESTIMATE_BAND
}