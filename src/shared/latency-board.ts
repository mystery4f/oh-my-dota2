/**
 * #114：延迟板——用样本说话，没样本就说没样本。
 *
 * 只做两件事：把采样窗口里**已经记下的**那些数按供应商分组算 P50/P95，以及数清超时与失败。
 * 没有任何推断，也没有预测：没有样本的供应商不做「估计」，直接给一行「还没有样本」——
 * 让用户按数字挑服务商的前提是这些数字只来自真实回合。
 *
 * 为什么是 P50/P95 而不是平均：服务端首字节能从 1.3s 抖到 31s，平均值会把这种抖动摊平。
 */

export interface LatencyBoardSample {
  /** 供应商 id（`provider.id`），空串表示没记到是哪家。 */
  provider: string
  ms: number
  /** `translator-latency` 的来源分类：`timeout` / `error` 就是这里的失败类。 */
  source: 'session' | 'direct' | 'timeout' | 'error'
}

export interface LatencyBoardRow {
  provider: string
  /** 参与统计的样本数（成功 + 失败都在里面，失败也是真实耗时）。 */
  samples: number
  p50: number | null
  p95: number | null
  timeouts: number
  errors: number
  /** 面板那一句：没样本时必须是「还没有样本」，不是 0ms。 */
  line: string
}

/**
 * 分位数用「最近秩」：`sorted[floor(n * ratio)]`。
 * 后果是样本少时 P95 会落在最大值上（n=11 时 P95 就是最慢那次）——这是最近秩的固有性质，
 * 不是 bug：样本少的时候本来就该让人看见最坏那次。空样本给 null，绝不给 0。
 */
export function percentileOf(sorted: readonly number[], ratio: number): number | null {
  if (sorted.length === 0) return null
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * ratio))
  return sorted[index] ?? null
}

/** 一组样本的分位数与失败类计数。 */
export function rowOf(provider: string, samples: readonly LatencyBoardSample[]): LatencyBoardRow {
  const times = samples.filter((sample) => sample.provider === provider).map((sample) => sample.ms).sort((a, b) => a - b)
  const own = samples.filter((sample) => sample.provider === provider)
  const timeouts = own.filter((sample) => sample.source === 'timeout').length
  const errors = own.filter((sample) => sample.source === 'error').length
  const p50 = percentileOf(times, 0.5)
  const p95 = percentileOf(times, 0.95)
  const line =
    times.length === 0
      ? '还没有样本'
      : `${times.length} 次 · P50 ${Math.round(p50 ?? 0)}ms · P95 ${Math.round(p95 ?? 0)}ms${timeouts > 0 ? ` · 超时 ${timeouts}` : ''}${errors > 0 ? ` · 失败 ${errors}` : ''}`
  return { provider, samples: times.length, p50, p95, timeouts, errors, line }
}

/**
 * 整块板：**只出现给定的供应商**（设置里有的那些），一个都没打过交道也照样占一行，
 * 因为「这家没样本」本身就是用户挑服务商时要看到的信息。
 */
export function latencyBoardOf(samples: readonly LatencyBoardSample[], providers: readonly string[]): LatencyBoardRow[] {
  const seen = new Set(providers)
  // 样本里出现、但设置里已经没有的供应商也留着：它打过交道，删掉会让人以为从没发生。
  for (const sample of samples) if (sample.provider !== '') seen.add(sample.provider)
  return [...seen].map((provider) => rowOf(provider, samples))
}