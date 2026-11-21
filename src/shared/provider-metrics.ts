/**
 * 供应商看板（#114）：每一次模型调用记一行，按（供应商 × 模型）汇总成一张表。
 *
 * 为什么要这张表：#86 让每类失败都有自己的措辞，但**没有地方能回答「这周到底失败了几次、慢到什么程度」**。
 * 这里只做汇总，不做判定——失败分类仍然只由 `src/shared/provider-failure.ts` 决定。
 *
 * 口径：
 * - 一行 = 一次调用（成功也算），`ms` 是端到端墙钟，含排队与网络；
 * - 中位数而不是平均：一两次超时会把平均拉到没有意义的地方；
 * - 失败的分类按 `ProviderFailureKind` 数，**不合并**——「限流 3 次」和「超时 3 次」是两件事。
 */

export interface ProviderCall {
  at: string
  providerId: string
  model: string
  ok: boolean
  ms: number
  /** 失败时的分类；成功为 null。 */
  kind: string | null
}

export interface ProviderKindCount {
  kind: string
  count: number
}

export interface ProviderRow {
  providerId: string
  model: string
  calls: number
  failures: number
  failureRate: number
  p50Ms: number
  slowestMs: number
  kinds: ProviderKindCount[]
}

export interface ProviderBoard {
  total: number
  failures: number
  rows: ProviderRow[]
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? Math.round((sorted[middle - 1] + sorted[middle]) / 2) : sorted[middle]
}

/** 按（供应商 × 模型）汇总，次数多的排前面；同次数失败多的排前面。 */
export function summarizeProviderCalls(calls: readonly ProviderCall[]): ProviderBoard {
  const groups = new Map<string, ProviderCall[]>()
  for (const call of calls) {
    const key = `${call.providerId}\u0000${call.model}`
    const list = groups.get(key)
    if (list === undefined) groups.set(key, [call])
    else list.push(call)
  }

  const rows: ProviderRow[] = []
  for (const list of groups.values()) {
    const failures = list.filter((call) => !call.ok).length
    const kinds = new Map<string, number>()
    for (const call of list) {
      if (call.kind === null) continue
      kinds.set(call.kind, (kinds.get(call.kind) ?? 0) + 1)
    }
    rows.push({
      providerId: list[0].providerId,
      model: list[0].model,
      calls: list.length,
      failures,
      failureRate: list.length === 0 ? 0 : failures / list.length,
      p50Ms: median(list.map((call) => call.ms)),
      slowestMs: list.reduce((max, call) => (call.ms > max ? call.ms : max), 0),
      kinds: [...kinds.entries()]
        .map(([kind, count]) => ({ kind, count }))
        .sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind))
    })
  }

  rows.sort((a, b) => b.calls - a.calls || b.failures - a.failures || a.providerId.localeCompare(b.providerId))
  return {
    total: calls.length,
    failures: calls.filter((call) => !call.ok).length,
    rows
  }
}

/** `1.4 秒` / `820 毫秒`：看板上不给人读 8 位数毫秒。 */
export function formatMs(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  return `${(ms / 1000).toFixed(1)} 秒`
}

/** 一行摘要：`共 42 次 · 失败 3 次（7%）· 最慢 12.3 秒`。 */
export function providerBoardLine(board: ProviderBoard): string {
  if (board.total === 0) return '还没调用过模型'
  const rate = Math.round((board.failures / board.total) * 100)
  const slowest = board.rows.reduce((max, row) => (row.slowestMs > max ? row.slowestMs : max), 0)
  return `共 ${board.total} 次 · 失败 ${board.failures} 次（${rate}%）· 最慢 ${formatMs(slowest)}`
}

/** 一条失败的短描述：`限流 3 次 · 超时 1 次`。 */
export function providerKindsLine(row: ProviderRow): string {
  if (row.kinds.length === 0) return '没有失败'
  return row.kinds.map((item) => `${item.kind} ${item.count} 次`).join(' · ')
}
