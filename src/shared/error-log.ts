/**
 * 本地异常清单（backlog 第七节 P3）。纯缝：只做归类、去重、排序，不碰文件与进程。
 *
 * 为什么要有这一层：主进程里一个没被接住的错误，现状只有两种结局——Electron 弹一个
 * 「A JavaScript error occurred in the main process」对话框（用户看不懂，也复制不出来），
 * 或者进程直接没了。两种都不留下可以贴给人看的东西。这里把「哪一类、说了什么、出现几次、
 * 最后一次什么时候」整理成一段能被面板直接念出来的摘要。
 *
 * 边界：不联网、不上报、不猜严重程度。`kind` 只说来源（未捕获 / 未处理的 promise / 渲染层），
 * 因为「严不严重」取决于那一行代码正在干什么，缝里判断不了。
 */

export type ErrorKind = 'uncaught' | 'rejection' | 'renderer'

export interface ErrorRecord {
  /** ISO 时间戳。字符串而不是 Date：这一行要能原样进 jsonl 再原样回来。 */
  at: string
  kind: ErrorKind
  message: string
  stack: string | null
  /** 触发时的处境，比如 `translate:session`；拿不到就 null，不编。 */
  context: string | null
}

export const ERROR_KIND_LABEL: Record<ErrorKind, string> = {
  uncaught: '未捕获',
  rejection: '未处理 promise',
  renderer: '渲染层'
}

/** 内存里留多少条。清单是给人看的线索，不是审计日志。 */
export const ERROR_KEEP = 50

const KINDS: readonly ErrorKind[] = ['uncaught', 'rejection', 'renderer']

function isKind(value: unknown): value is ErrorKind {
  return typeof value === 'string' && (KINDS as readonly string[]).includes(value)
}

/**
 * 把任何东西变成一条记录：主进程接住的可能是 `Error`，promise 里可能是字符串或对象，
 * 渲染层来的是 `{ message, stack }`。认不出来的输入返回 null——写一条「undefined」进清单
 * 比不写更糟，它会把真正的第一条线索挤掉。
 */
export function normalizeErrorInput(raw: unknown, kind: ErrorKind, at = new Date()): ErrorRecord | null {
  if (raw === null || raw === undefined) return null
  const source = raw as { message?: unknown; stack?: unknown; context?: unknown }
  let message = ''
  if (raw instanceof Error) message = raw.message
  else if (typeof raw === 'string') message = raw
  else if (typeof source.message === 'string') message = source.message
  else if (typeof raw === 'object') {
    try {
      message = JSON.stringify(raw)
    } catch {
      message = String(raw)
    }
  } else message = String(raw)

  const text = message.trim()
  if (text === '') return null
  const stack = typeof source.stack === 'string' && source.stack.trim() !== '' ? source.stack : null
  const context = typeof source.context === 'string' && source.context.trim() !== '' ? source.context : null
  return { at: at.toISOString(), kind, message: text, stack, context }
}

export interface ErrorGroup {
  kind: ErrorKind
  message: string
  count: number
  newest: string
  sample: ErrorRecord
}

export interface ErrorSummary {
  total: number
  distinct: number
  byKind: Record<ErrorKind, number>
  newest: string | null
  /** 次数降序 → 最近出现的先；面板只念前几条。 */
  groups: ErrorGroup[]
}

/** 同一类同一句话算一条，次数累加。消息完全相同才算同一件事，不做模糊合并（会掩盖两次不同的崩）。 */
export function summarizeErrors(records: readonly ErrorRecord[], top = 5): ErrorSummary {
  const byKind: Record<ErrorKind, number> = { uncaught: 0, rejection: 0, renderer: 0 }
  const buckets = new Map<string, ErrorGroup>()
  let newest: string | null = null

  for (const record of records) {
    if (!isKind(record.kind)) continue
    byKind[record.kind] += 1
    if (newest === null || record.at > newest) newest = record.at
    const key = `${record.kind}\u0000${record.message}`
    const found = buckets.get(key)
    if (found) {
      found.count += 1
      if (record.at > found.newest) {
        found.newest = record.at
        found.sample = record
      }
      continue
    }
    buckets.set(key, { kind: record.kind, message: record.message, count: 1, newest: record.at, sample: record })
  }

  const groups = Array.from(buckets.values()).sort((a, b) => b.count - a.count || (a.newest < b.newest ? 1 : -1))
  return {
    total: records.length,
    distinct: groups.length,
    byKind,
    newest,
    groups: groups.slice(0, Math.max(0, top))
  }
}

/** 面板一行话：有错误说清「几次、最近哪次、最常出现的是哪句」，没有就照实说没有。 */
export function errorsLine(summary: ErrorSummary): string {
  if (summary.total === 0) return '没有记录到异常'
  const head = summary.groups[0]
  const when = summary.newest === null ? '' : ` · 最近 ${summary.newest.slice(11, 19)}`
  return head === undefined
    ? `${summary.total} 条异常${when}`
    : `${summary.total} 条异常${when} · 最常见：${head.message.slice(0, 60)}（${head.count} 次）`
}
