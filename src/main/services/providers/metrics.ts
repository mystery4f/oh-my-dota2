/**
 * 供应商看板的记账（#114）。
 *
 * 每次 `chatCompletion()` 一行，写在 `logs/provider-metrics.jsonl`（`logsDir()` 下，
 * 探针模式落临时根），256 KB 上限。内存里也留一份最近 500 行，面板读内存不读盘。
 *
 * 记账**绝不抛**：这是诊断用的旁路，记不上不该让一次翻译失败。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { appendCappedJsonl } from '../logs/jsonl'
import { logsDir } from '../logs/base-dir'
import { summarizeProviderCalls, type ProviderBoard, type ProviderCall } from '@shared/provider-metrics'

const FILE_NAME = 'provider-metrics.jsonl'
const MAX_BYTES = 256 * 1024
const MEMORY_KEEP = 500

export function providerMetricsPath(): string {
  return join(logsDir(), FILE_NAME)
}

let memory: ProviderCall[] | null = null

function isCall(value: unknown): value is ProviderCall {
  if (typeof value !== 'object' || value === null) return false
  const row = value as Partial<ProviderCall>
  return (
    typeof row.at === 'string' &&
    typeof row.providerId === 'string' &&
    typeof row.model === 'string' &&
    typeof row.ok === 'boolean' &&
    typeof row.ms === 'number' &&
    (row.kind === null || typeof row.kind === 'string')
  )
}

function loadOnce(): ProviderCall[] {
  if (memory !== null) return memory
  let raw = ''
  try {
    raw = readFileSync(providerMetricsPath(), 'utf8')
  } catch {
    memory = []
    return memory
  }
  const rows: ProviderCall[] = []
  for (const line of raw.split('\n')) {
    const text = line.trim()
    if (text === '') continue
    try {
      const parsed: unknown = JSON.parse(text)
      if (isCall(parsed)) rows.push(parsed)
    } catch {
      // 半行/脏行当没写过：一行坏记录不该让整张看板读不出来。
    }
  }
  memory = rows.slice(-MEMORY_KEEP)
  return memory
}

/** 记一次调用。`ms` 由调用方量（端到端墙钟）。 */
export function recordProviderCall(input: {
  providerId: string
  model: string
  ok: boolean
  ms: number
  kind?: string | null
  at?: string
}): void {
  try {
    const call: ProviderCall = {
      at: input.at ?? new Date().toISOString(),
      providerId: input.providerId,
      model: input.model,
      ok: input.ok,
      ms: Math.max(0, Math.round(input.ms)),
      kind: input.ok ? null : (input.kind ?? 'unknown')
    }
    const rows = loadOnce()
    memory = [...rows, call].slice(-MEMORY_KEEP)
    appendCappedJsonl(providerMetricsPath(), { ...call }, MAX_BYTES)
  } catch {
    // 旁路记账，失败就当没记。
  }
}

export function providerBoard(): ProviderBoard {
  return summarizeProviderCalls(loadOnce())
}

/** 探针用：清空内存里的账（不动盘上的历史）。 */
export function resetProviderMetrics(): void {
  memory = []
}
