import { appendFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { app } from 'electron'
import type { TrainLogPage } from '@shared/train/task'

/**
 * 训练日志文件（`<userData>/logs/train.log`）的唯一读写口。
 *
 * 为什么单独一个文件：训练栈的 stdout、训练管理器自己的阶段行都落在同一份里，
 * 面板的「训练日志」和事后排查读的是它，写的是它 —— 两处各写一遍路径迟早会漂。
 * 写失败不能反过来影响训练，所以这里的每个写入口都是「尽力而为」。
 */

/** 落盘上限：一圈环形日志挡不住崩溃现场，磁盘这份才是事后唯一证据，超过就从头截断。 */
const TRAIN_LOG_MAX_BYTES = 4 * 1024 * 1024
/** 面板一次最多看多少行：够看清一轮训练，又不至于把渲染压住。 */
const DEFAULT_TAIL_LINES = 400

let trainLogSize = -1

export function trainLogPath(): string {
  return join(app.getPath('userData'), 'logs', 'train.log')
}

export function appendTrainLog(text: string): void {
  try {
    const file = trainLogPath()
    mkdirSync(dirname(file), { recursive: true })
    if (trainLogSize < 0) trainLogSize = statSync(file, { throwIfNoEntry: false })?.size ?? 0
    if (trainLogSize > TRAIN_LOG_MAX_BYTES) {
      writeFileSync(file, '')
      trainLogSize = 0
    }
    const line = `[${new Date().toISOString()}] ${text}\n`
    appendFileSync(file, line, 'utf8')
    trainLogSize += Buffer.byteLength(line)
  } catch {
    // 日志失败不影响训练
  }
}

/** 尾部若干行。文件不存在时给空页而不是抛错：还没训练过就是这种状态。 */
export function readTrainLogTail(limit = DEFAULT_TAIL_LINES): TrainLogPage {
  const path = trainLogPath()
  const size = Math.max(0, Math.min(DEFAULT_TAIL_LINES * 40, limit) | 0)
  try {
    const bytes = statSync(path, { throwIfNoEntry: false })?.size ?? 0
    if (bytes === 0) return { path, bytes: 0, lines: [], truncated: false }
    const text = readFileSync(path, 'utf8')
    const all = text.split('\n')
    if (all.length > 0 && all[all.length - 1] === '') all.pop()
    const want = size === 0 ? DEFAULT_TAIL_LINES : Math.min(size, 2000)
    return { path, bytes, lines: all.slice(-want), truncated: all.length > want }
  } catch {
    return { path, bytes: 0, lines: [], truncated: false }
  }
}
