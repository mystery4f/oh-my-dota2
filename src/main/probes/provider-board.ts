/**
 * --provider-board-probe：供应商看板（#114）。
 *
 * 钉的是口径而不是界面：一行 = 一次调用、中位数而不是平均、失败分类分开数不合并、
 * 没调用过时说「还没调用过」而不是 0% 成功率（那看着像全挂）。
 */
import {
  formatMs,
  providerBoardLine,
  providerKindsLine,
  summarizeProviderCalls,
  type ProviderCall
} from '@shared/provider-metrics'
import { providerBoard, providerMetricsPath, recordProviderCall, resetProviderMetrics } from '../services/providers/metrics'
import { logsDir } from '../services/logs/base-dir'
import { join } from 'node:path'
import { finishProbe, probeCases } from './harness'

export function runProviderBoardProbe(): void {
  const { cases, push } = probeCases()

  const call = (model: string, ok: boolean, ms: number, kind: string | null = null): ProviderCall => ({
    at: '2026-11-21T12:00:00.000Z',
    providerId: 'deepseek',
    model,
    ok,
    ms,
    kind
  })

  const empty = summarizeProviderCalls([])
  push('没调用过：0 次、0 失败、没有行', empty.total === 0 && empty.failures === 0 && empty.rows.length === 0)
  push('没调用过时文案说「还没调用过」，不写 0%', providerBoardLine(empty) === '还没调用过模型')

  const one = summarizeProviderCalls([call('deepseek-chat', true, 820)])
  push('一次成功：失败率 0、中位数就是它', one.total === 1 && one.failures === 0 && one.rows[0].failureRate === 0 && one.rows[0].p50Ms === 820)

  const mixed = summarizeProviderCalls([
    call('deepseek-chat', true, 800),
    call('deepseek-chat', true, 1000),
    call('deepseek-chat', false, 30_000, 'timeout'),
    call('deepseek-chat', false, 500, 'rate-limit'),
    call('deepseek-chat', false, 500, 'rate-limit'),
    call('glm-4-flash', true, 1200)
  ])
  push('总数与失败数按行数数', mixed.total === 6 && mixed.failures === 3, `${mixed.total}/${mixed.failures}`)
  push('按（供应商 × 模型）分组', mixed.rows.length === 2 && mixed.rows[0].model === 'deepseek-chat')
  push('中位数取中间值，不是平均（平均会被超时拉走）', mixed.rows[0].p50Ms === 800, String(mixed.rows[0].p50Ms))
  push('最慢的那次单独留一个数', mixed.rows[0].slowestMs === 30_000)
  push('失败分类分开数，不合并', mixed.rows[0].kinds.length === 2 && mixed.rows[0].kinds[0].kind === 'rate-limit' && mixed.rows[0].kinds[0].count === 2)
  push('成功不产生分类', mixed.rows[1].kinds.length === 0)
  push('一行的分类文案把每类都写出来', providerKindsLine(mixed.rows[0]).includes('rate-limit 2 次') && providerKindsLine(mixed.rows[0]).includes('timeout 1 次'))
  push('没有失败时那行说没有失败', providerKindsLine(mixed.rows[1]) === '没有失败')
  push('行按次数排序，次数多的在前', mixed.rows[0].calls >= mixed.rows[1].calls)

  push('毫秒与秒分档', formatMs(820) === '820 毫秒' && formatMs(12340) === '12.3 秒', `${formatMs(820)} / ${formatMs(12340)}`)
  push('一行摘要带次数、失败次数与最慢', providerBoardLine(mixed).includes('共 6 次') && providerBoardLine(mixed).includes('失败 3 次') && providerBoardLine(mixed).includes('30.0 秒'), providerBoardLine(mixed))

  // —— 真入口：记账与读回 ——
  push(
    '记账写在 logs 根下（探针模式就是临时根）',
    providerMetricsPath() === join(logsDir(), 'provider-metrics.jsonl'),
    `${providerMetricsPath()} vs ${join(logsDir(), 'provider-metrics.jsonl')}`
  )
  resetProviderMetrics()
  push('清账之后看板是空的', providerBoard().total === 0)
  recordProviderCall({ providerId: 'probe', model: 'm1', ok: true, ms: 640 })
  recordProviderCall({ providerId: 'probe', model: 'm1', ok: false, ms: 1500, kind: 'auth' })
  const recorded = providerBoard()
  push('记两条就数两条，失败带分类', recorded.total === 2 && recorded.failures === 1 && recorded.rows[0].kinds[0].kind === 'auth', JSON.stringify(recorded.rows[0]))
  push('自己记的行不会跟别人的混在一起', recorded.rows.length === 1 && recorded.rows[0].providerId === 'probe')

  finishProbe('PROVIDER_BOARD_PROBE', cases, {
    file: providerMetricsPath(),
    rows: mixed.rows.length,
    total: mixed.total
  })
}
