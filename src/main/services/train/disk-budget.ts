/**
 * #108：把磁盘预算接上真实数字。
 *
 * 纯判断在 `@shared/train/disk-budget`，这里只做两件事：量尺寸、取可用空间。
 * 一条硬规则：**量不到就不拦**。`statfsSync` 在少数卷（网络盘、被策略限制的挂载）会抛错，
 * 那时「不知道还剩多少」不等于「不够」——拦下去会把一台本来能跑的机器锁死，而这个错误没人能自助解决。
 */
import { readdirSync, statfsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { estimateTrainFootprint, formatGb, judgeDiskBudget, type DiskBudget } from '@shared/train/disk-budget'
import { ftModelDirs } from './asr-ft'

/** 目录字节数的唯一实现（探针也读它，免得两处各写一遍递归）。读不到的子项按 0 算：估算宁小勿崩。 */
export function measureDirBytes(dir: string): number {
  let total = 0
  let entries: Array<{ name: string }> = []
  try {
    entries = readdirSync(dir, { withFileTypes: true })
  } catch {
    return 0
  }
  for (const entry of entries) {
    const full = join(dir, (entry as { name: string }).name)
    try {
      const info = statSync(full)
      if (info.isDirectory()) total += measureDirBytes(full)
      else total += info.size
    } catch {
      // 单个文件读不到（权限、刚被清理）：算 0，不让整次估算失败。
    }
  }
  return total
}

/** 可用空间；量不到返回 null（调用方据此跳过检查，绝不把它当成 0）。 */
export function freeBytesAt(dir: string): number | null {
  try {
    const stats = statfsSync(dir)
    return Number(stats.bavail) * Number(stats.bsize)
  } catch {
    return null
  }
}

/** 这一批录音的字节数；账本里缺 `bytes` 的条目按 0 算。 */
export function datasetBytesOfLedger(ledger: readonly { bytes?: number }[]): number {
  return ledger.reduce((sum, entry) => sum + (Number.isFinite(entry.bytes) ? Number(entry.bytes) : 0), 0)
}

export interface DiskBudgetCheck {
  /** 量到了就有值；`null` 表示这次没量成（网络盘、权限），调用方必须放行。 */
  budget: DiskBudget | null
  /** 日志与面板共用的一句话：够 / 不够 / 没量成，三种都必须说清楚。 */
  line: string
}

/**
 * 开训前的磁盘检查。`userDataDir` 是数据根（默认就是可用空间要看的那个卷）。
 */
export function checkDiskBudgetForRun(input: { userDataDir: string; datasetBytes: number }): DiskBudgetCheck {
  const weightsBytes = measureDirBytes(ftModelDirs().active)
  const estimateBytes = estimateTrainFootprint({ weightsBytes, datasetBytes: input.datasetBytes })
  const freeBytes = freeBytesAt(input.userDataDir)
  if (freeBytes === null) {
    return {
      budget: null,
      line: `量不到可用空间（${input.userDataDir}），这次不拦；估算这一轮要占 ${formatGb(estimateBytes)}`
    }
  }
  const budget = judgeDiskBudget({ estimateBytes, freeBytes })
  return { budget, line: budget.line }
}

/**
 * 开训闸门：把「够不够」变成一个可测的 ok/error。
 * `budget === null` 表示这次没量成——放行（见文件头的规则），错误信息只在真的不够时给出。
 */
export function diskGate(check: DiskBudgetCheck): { ok: boolean; error: string | null } {
  if (check.budget !== null && !check.budget.ok) return { ok: false, error: check.budget.line }
  return { ok: true, error: null }
}