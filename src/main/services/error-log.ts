/**
 * 本地异常清单的落盘与登记（`--error-log-probe` 钉纯缝，这一层只做 IO 与进程钩子）。
 *
 * 装钩子的时机在 `app.whenReady()` 之前：Electron 主进程里一个早于窗口的错误同样会弹框，
 * 而那时用户还没有任何可以贴出来的东西。装在这里，它至少进得了 `logs/errors.jsonl`。
 *
 * 钩子**不吞异常**：`uncaughtException` 之后进程状态未定，按 Node 的默认行为继续（Electron
 * 仍会弹它自己的框），我们只多留一份证据。这也意味着这里绝不能抛——写日志失败就静默放过，
 * 记录异常的代码把异常抛出去是另一种事故。
 */
import { appendCappedJsonl } from './logs/jsonl'
import { logsDir } from './logs/base-dir'
import { join } from 'node:path'
import {
  ERROR_KEEP,
  normalizeErrorInput,
  summarizeErrors,
  type ErrorKind,
  type ErrorRecord,
  type ErrorSummary
} from '@shared/error-log'

const MAX_BYTES = 256 * 1024
const buffer: ErrorRecord[] = []

export function errorsLogPath(): string {
  return join(logsDir(), 'errors.jsonl')
}

/** 记一条。返回值给探针用，生产里没人看。 */
export function noteError(raw: unknown, kind: ErrorKind, context: string | null = null): ErrorRecord | null {
  try {
    const record = normalizeErrorInput(raw, kind, new Date())
    if (record === null) return null
    const withContext: ErrorRecord = context === null ? record : { ...record, context }
    buffer.push(withContext)
    if (buffer.length > ERROR_KEEP) buffer.splice(0, buffer.length - ERROR_KEEP)
    appendCappedJsonl(errorsLogPath(), { ...withContext }, MAX_BYTES)
    return withContext
  } catch {
    // 记日志本身失败就放过：这里抛出去会把「记录异常」变成第二种异常。
    return null
  }
}

export function errorsSummary(top = 5): ErrorSummary {
  return summarizeErrors(buffer, top)
}

/** 探针用：清掉内存里的样本，避免同一进程里前一段的结果被后一段看到。 */
export function resetErrorLog(): void {
  buffer.length = 0
}

let installed = false

/**
 * 装主进程钩子。重复调用无副作用（`whenReady` 与探针都可能调它）。
 */
export function installErrorHandlers(): void {
  if (installed) return
  installed = true
  process.on('uncaughtException', (error) => {
    noteError(error, 'uncaught', 'main')
  })
  process.on('unhandledRejection', (reason) => {
    noteError(reason, 'rejection', 'main')
  })
}
