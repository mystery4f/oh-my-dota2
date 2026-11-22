/**
 * 保真守卫的事件落盘：攒一批再写。
 *
 * 守卫事件本身是稀疏的（只有判违例才有），所以这里不需要复杂的采样：事件先进内存，
 * 满 `FLUSH_EVERY` 条或定时器到点才整批 append 一次。正常译文一行都不写——这是
 * 「有数字」和「不拖慢 inplace 热路径」唯一能同时成立的做法。
 *
 * 文件与 `voice-chain.jsonl` 同目录（`logs/translate-guard.jsonl`），周报用
 * `summarizeGuardLog`（shared/guard-telemetry）算三段：judged / recovered / gaveUp。
 */
import { join } from 'node:path'
import { appendCappedJsonlMany } from '../logs/jsonl'
import { logsDir } from '../logs/base-dir'
import type { GuardEvent } from '@shared/guard-telemetry'

/** 攒够这么多条就落盘。守卫事件稀疏，20 条大约是一天的量级。 */
const FLUSH_EVERY = 20
/** 上限与其它证据日志一致：这是排障留痕，不是永久历史。 */
const MAX_BYTES = 256 * 1024

let buffer: GuardEvent[] = []

export function guardLogPath(): string {
  return join(logsDir(), 'translate-guard.jsonl')
}

/** 一条违例事件的唯一入口：`guardedTranslate` 的 reporter 直接指向它。 */
export function reportGuardEvent(event: GuardEvent): void {
  buffer.push(event)
  if (buffer.length >= FLUSH_EVERY) flushGuardTelemetry()
}

/** 把缓冲区整批写盘。退出前必须调一次，否则最后几条只活到进程结束。 */
export function flushGuardTelemetry(): void {
  if (buffer.length === 0) return
  const batch = buffer
  buffer = []
  appendCappedJsonlMany(guardLogPath(), batch, MAX_BYTES)
}

/** 只给探针用：看缓冲区里还有几条没落盘。 */
export function pendingGuardEvents(): number {
  return buffer.length
}
