import { applyAsrFtModel, asrFtStatus } from '../services/train/asr-ft'
import { asrFtSwapSteps } from '@shared/train/asr-ft'
import { exitProbe } from './harness'

/**
 * 一次性排查探针（诊断用，不进 PROBES.md 的常驻清单）：打印换模四态与实际会走的步骤，
 * 带 `--asr-swap-apply` 时再真的跑一次 applyAsrFtModel，看它到底哪一步失败。
 */
export async function runAsrSwapProbe(): Promise<void> {
  const status = await asrFtStatus()
  const swap = status.swap
  console.log('SWAP', JSON.stringify(swap))
  console.log('TARGET', JSON.stringify(status.target))
  console.log('STEPS', JSON.stringify(asrFtSwapSteps({ ...swap, exportExists: Boolean(swap.lastExportDir) })))
  let ok = true
  if (process.argv.includes('--asr-swap-apply')) {
    const result = applyAsrFtModel()
    console.log('APPLY', JSON.stringify(result))
    console.log('SWAP_AFTER', JSON.stringify((await asrFtStatus()).swap))
    ok = result.ok
  }
  // 诊断探针也要有结论：真的跑了 apply 就按它的结果定成败。
  exitProbe(ok)
}
