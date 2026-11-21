/**
 * #114 探针：延迟板。
 *
 * 票面验收：
 * - `Numbers derive from the recorded samples only` → 板上的 P50/P95 全部由给定样本重算得出：
 *   这里手算一组（10 个值）对上 `rowOf` 的分位数，并断言样本一变数字就跟着变；
 * - `a provider with no samples says so` → 设置里有、但一次都没打过交道的供应商，
 *   行上必须是 `samples: 0` + 文案「还没有样本」，而不是 `0ms`。
 *
 * 另钉两条边界：失败的回合也算样本（失败也有真实耗时），以及「有样本但设置里已删除」的供应商
 * 不会被抹掉（删掉会让人以为从没发生过）。
 */
import { latencyBoardOf, percentileOf, rowOf, type LatencyBoardSample } from '@shared/latency-board'
import { finishProbe, probeCases } from './harness'

export async function runLatencyBoardProbe(): Promise<void> {
  const { cases, push } = probeCases()

  const samples: LatencyBoardSample[] = [
    ...[100, 200, 300, 400, 500, 600, 700, 800, 900, 1000].map((ms) => ({ provider: 'a', ms, source: 'session' as const })),
    { provider: 'a', ms: 3000, source: 'timeout' },
    { provider: 'b', ms: 1200, source: 'error' },
    { provider: 'b', ms: 800, source: 'direct' }
  ]

  // —— 验收一：只由样本算出，手算对得上 ——
  const a = rowOf('a', samples)
  push('样本数等于该供应商的回合数', a.samples === 11, String(a.samples))
  push('P50 取已排序样本的中位', a.p50 === 600, String(a.p50))
  // 最近秩：n=11 时 P95 落在第 11 个（也就是最慢那次），这是定义使然，不是把最大值当分位。
  push('P95 用最近秩（样本少时落在最慢那次）', a.p95 === 3000, String(a.p95))
  push('失败也进样本', a.timeouts === 1 && a.errors === 0)
  push('文案给出次数与两个分位', a.line.includes('11 次') && a.line.includes('P50 600ms') && a.line.includes('P95 3000ms'), a.line)

  const b = rowOf('b', samples)
  push('另一家自己算自己的（两个样本的中位取高位）', b.p50 === 1200 && b.errors === 1 && b.timeouts === 0, b.line)
  push('样本一变数字就变', rowOf('a', [{ provider: 'a', ms: 42, source: 'session' }]).p50 === 42)
  push('分位数对空样本给 null，不给 0', percentileOf([], 0.5) === null && percentileOf([], 0.95) === null)

  // —— 验收二：没样本就说没样本 ——
  const board = latencyBoardOf(samples, ['a', 'b', 'c'])
  const c = board.find((row) => row.provider === 'c')
  push('设置里有、没打过交道：占一行', c !== undefined, JSON.stringify(board.map((row) => row.provider)))
  push('没样本：samples 0、分位 null、文案「还没有样本」', c !== undefined && c.samples === 0 && c.p50 === null && c.p95 === null && c.line === '还没有样本', c?.line ?? '')
  push('没样本的行不出现 0ms', c !== undefined && !c.line.includes('0ms'), c?.line ?? '')

  // —— 边界 ——
  const extra = latencyBoardOf([{ provider: 'z', ms: 100, source: 'session' }], ['a'])
  push('有样本但设置里已删除的供应商不丢', extra.some((row) => row.provider === 'z') && extra.some((row) => row.provider === 'a'))
  push('空串供应商不进板', !latencyBoardOf([{ provider: '', ms: 10, source: 'session' }], []).some((row) => row.provider === ''))
  push('一家的超时不影响另一家的数字', b.timeouts === 0 && a.errors === 0)

  finishProbe('LATENCY_BOARD_PROBE', cases)
}