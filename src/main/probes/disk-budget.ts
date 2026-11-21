/**
 * #108 探针：开训前的磁盘预算。
 *
 * 票面验收：
 * - `a low-space volume blocks the start with the measured numbers` → 判断层用「要多少 / 剩多少」两句话测，
 *   拒绝句里必须带这两个数字；
 * - `the estimate is within a stated band of the actual size` → 真造一个「一轮 run 目录」的样子
 *   （权重三份 + 这批录音），把估算与实际测量放进 `TRAIN_ESTIMATE_BAND` 里比。
 *
 * 也钉住反向的那条规则：量不到可用空间（网络盘、权限）时不拦，只出一句「没量成」——
 * 否则一台本来能跑的机器会被一个查不到原因的拒绝锁死。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { finishProbe, probeCases } from './harness'
import {
  TRAIN_CHECKPOINT_COPIES,
  TRAIN_ESTIMATE_BAND,
  TRAIN_HEADROOM,
  estimateTrainFootprint,
  estimateWithinBand,
  formatGb,
  judgeDiskBudget
} from '@shared/train/disk-budget'
import { datasetBytesOfLedger, diskGate, freeBytesAt, measureDirBytes } from '../services/train/disk-budget'

const MB = 1024 * 1024
const GB = 1024 ** 3

function makeDir(root: string, name: string, files: Record<string, number>): string {
  const dir = join(root, name)
  mkdirSync(dir, { recursive: true })
  for (const [file, size] of Object.entries(files)) {
    writeFileSync(join(dir, file), Buffer.alloc(size, 7))
  }
  return dir
}

export async function runDiskBudgetProbe(): Promise<void> {
  const { cases, push } = probeCases()
  const root = mkdtempSync(join(tmpdir(), 'disk-budget-'))

  try {
    // —— 纯层：估算与余量 ——
    const estimate = estimateTrainFootprint({ weightsBytes: 2 * GB, datasetBytes: 100 * MB })
    push('估算 = 权重 × 3 + 录音', estimate === 2 * GB * TRAIN_CHECKPOINT_COPIES + 100 * MB, formatGb(estimate))
    push('负数与 NaN 一律按 0（估算不许更乐观）', estimateTrainFootprint({ weightsBytes: -5, datasetBytes: Number.NaN }) === 0)

    const low = judgeDiskBudget({ estimateBytes: 10 * GB, freeBytes: 3 * GB })
    push('盘不够：判不通过', low.ok === false)
    push('盘不够：需要量 = 估算 + 30% 余量', low.needBytes === Math.ceil(10 * GB * (1 + TRAIN_HEADROOM)), formatGb(low.needBytes))
    push(
      '盘不够：句子同时带上「要多少」和「剩多少」',
      low.line.includes(formatGb(low.needBytes)) && low.line.includes(formatGb(3 * GB)) && low.line.includes('清掉旧的'),
      low.line
    )

    const enough = judgeDiskBudget({ estimateBytes: 10 * GB, freeBytes: 40 * GB })
    push('盘够：判通过且句子带三个数字', enough.ok === true && enough.line.includes(formatGb(10 * GB)) && enough.line.includes(formatGb(40 * GB)), enough.line)

    push('GB 文案一位小数', formatGb(1536 * MB) === '1.5 GB' && formatGb(0) === '0.0 GB' && formatGb(-1) === '0.0 GB', formatGb(1536 * MB))

    // —— 区间：估算与实测不许各说各的 ——
    push('估算与实测相同：在区间内', estimateWithinBand(100, 100))
    push('偏差 50%：正好在区间边界内', estimateWithinBand(150, 100) && estimateWithinBand(50, 100))
    push('偏差 60%：出区间', estimateWithinBand(160, 100) === false)
    push('实测为 0：不算在区间内', estimateWithinBand(0, 0) === false)

    // —— 真量：目录字节数、可用空间、账本求和 ——
    const weightsDir = makeDir(root, 'weights', { 'model.onnx': 3 * MB, 'model.int8.onnx': 1 * MB })
    mkdirSync(join(weightsDir, 'tokenizer'), { recursive: true })
    writeFileSync(join(weightsDir, 'tokenizer', 'vocab.json'), Buffer.alloc(MB, 1))
    push('目录字节数含子目录', measureDirBytes(weightsDir) === 5 * MB, String(measureDirBytes(weightsDir)))
    push('不存在的目录：按 0 算，不抛', measureDirBytes(join(root, 'nope')) === 0)

    const free = freeBytesAt(root)
    push('临时目录报得出可用空间（正数）', free !== null && free > 0, free === null ? 'null' : formatGb(free))
    push('量不到可用空间：返回 null，而不是 0', freeBytesAt(join(root, 'no-such-volume')) === null)

    push(
      '账本求和：缺 bytes 的条目按 0',
      datasetBytesOfLedger([{ bytes: 10 }, { bytes: 5 }, {}]) === 15,
      String(datasetBytesOfLedger([{ bytes: 10 }, { bytes: 5 }, {}]))
    )

    // —— 一轮 run 目录长什么样：权重三份 + 录音，估算要落在区间内 ——
    const runDir = join(root, 'run')
    for (let copy = 0; copy < TRAIN_CHECKPOINT_COPIES; copy += 1) {
      makeDir(join(runDir, `ckpt-${copy}`), 'model', { 'model.onnx': 2 * MB })
    }
    makeDir(runDir, 'dataset', { 'a.wav': MB, 'b.wav': MB })
    const actual = measureDirBytes(runDir)
    const runEstimate = estimateTrainFootprint({ weightsBytes: 2 * MB, datasetBytes: 2 * MB })
    push(
      `估算落在实测 ±${Math.round(TRAIN_ESTIMATE_BAND * 100)}% 内`,
      estimateWithinBand(runEstimate, actual),
      `估算 ${formatGb(runEstimate)} / 实测 ${formatGb(actual)}`
    )

    // —— 闸门本身：盘不够才拒，量不到就放行 ——
    const blocked = diskGate({ budget: low, line: low.line })
    push('闸门：盘不够就拒绝，拒绝语就是带数字的那一句', blocked.ok === false && blocked.error === low.line, blocked.error ?? '')
    const letThrough = diskGate({ budget: null, line: '量不到可用空间' })
    push('闸门：量不到可用空间就放行', letThrough.ok === true && letThrough.error === null)
    const openGate = diskGate({ budget: enough, line: enough.line })
    push('闸门：盘够就放行', openGate.ok === true)

    // —— 拒绝路径不产生任何副作用：judge 是纯函数，调两次结果一致 ——
    const first = judgeDiskBudget({ estimateBytes: 12 * GB, freeBytes: 1 * GB })
    const second = judgeDiskBudget({ estimateBytes: 12 * GB, freeBytes: 1 * GB })
    push('纯函数：同样的输入两次结果一致', first.line === second.line && first.needBytes === second.needBytes)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }

  finishProbe('DISK_BUDGET_PROBE', cases)
}