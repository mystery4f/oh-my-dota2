/**
 * 翻译延迟记账：采样窗口与分位统计。
 * 从 durable-translator 迁出（架构扫描 C3）：度量是观测面，不该和会话执行器长在一起。
 * 执行器在每回合结束时 trackLatency；面板/探针经 sessionStatus → latencySummary 读数。
 */

export type LatencySource = 'session' | 'direct' | 'timeout' | 'error'

export interface LatencySample {
  at: number
  ms: number
  source: LatencySource
  lines: number
}

/** 翻译抖动统计：服务端首字节能从 1.3s 抖到 31s，只看单次没用，必须看分位数。 */
export interface LatencySummary {
  count: number
  p50: number | null
  p90: number | null
  max: number | null
  session: number
  direct: number
  timeout: number
  error: number
  lastSource: LatencySource | null
  lastMs: number | null
}

const LATENCY_WINDOW = 60
const latencySamples: LatencySample[] = []

export function trackLatency(ms: number, source: LatencySource, lines: number): void {
  latencySamples.push({ at: Date.now(), ms: Math.round(ms), source, lines })
  if (latencySamples.length > LATENCY_WINDOW) latencySamples.splice(0, latencySamples.length - LATENCY_WINDOW)
}

export function latencySummary(): LatencySummary {
  const times = latencySamples.map((sample) => sample.ms).sort((a, b) => a - b)
  const pick = (ratio: number): number | null =>
    times.length === 0 ? null : times[Math.min(times.length - 1, Math.floor(times.length * ratio))]
  const count = (source: LatencySource): number => latencySamples.filter((sample) => sample.source === source).length
  const last = latencySamples[latencySamples.length - 1]
  return {
    count: latencySamples.length,
    p50: pick(0.5),
    p90: pick(0.9),
    max: times.length > 0 ? times[times.length - 1] : null,
    session: count('session'),
    direct: count('direct'),
    timeout: count('timeout'),
    error: count('error'),
    lastSource: last?.source ?? null,
    lastMs: last?.ms ?? null
  }
}
