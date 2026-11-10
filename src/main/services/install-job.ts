/**
 * 安装作业机：六套资产安装流（语音运行时 / ASR 模型 / 离线音色 / GV 本体 / 音色包 / 训练环境）
 * 共用的单飞闸门 + 错误收拢 + 进度转报。步骤本体（下载什么、怎么校验、装完干什么）
 * 是各家领域知识，留在各家模块里——这里只保证「同一时间一轮、失败不抛、进度有出口」。
 */
import { errorMessage } from '@shared/errors'

/** 一轮安装的三种归宿：busy=被单飞闸门拒绝（没开跑）；done=成功；failed=跑过但失败。 */
export type InstallJobResult = { kind: 'done' } | { kind: 'busy' } | { kind: 'failed'; error: string }

export interface InstallJob {
  /** 是否有作业在跑（闸门由机器持有，面板状态直接读它，不必自己留布尔）。 */
  running: () => boolean
  /**
   * 跑一轮：已在跑 → busy（不调 onStart，也不打日志）；
   * 否则 onStart → work(report) → onSettled(true, null)；
   * work 抛错 → onSettled(false, message)，错误不向上抛。
   * report(ratio, stage?)：ratio 0–1，stage 是可选的阶段名（如「解压中」）。
   */
  run: (opts: {
    busyError: string
    onStart?: () => void
    onProgress?: (ratio: number, stage?: string) => void
    onSettled?: (ok: boolean, error: string | null) => void
    work: (report: (ratio: number, stage?: string) => void) => Promise<void>
  }) => Promise<InstallJobResult>
}

/** 一族资产一个实例；按 key 区分的族（音色包按包 id）自己建 Map<string, InstallJob>。 */
export function createInstallJob(): InstallJob {
  let busy = false
  return {
    running: () => busy,
    run: async (opts) => {
      if (busy) return { kind: 'busy' }
      busy = true
      try {
        opts.onStart?.()
        await opts.work((ratio, stage) => opts.onProgress?.(ratio, stage))
        opts.onSettled?.(true, null)
        return { kind: 'done' }
      } catch (err) {
        const message = errorMessage(err)
        opts.onSettled?.(false, message)
        return { kind: 'failed', error: message }
      } finally {
        busy = false
      }
    }
  }
}
