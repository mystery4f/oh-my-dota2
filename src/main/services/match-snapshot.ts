/**
 * 副屏面板的唯一数据来源（#124b）：主进程留一份「最近一帧的可读摘要」。
 *
 * 不新开 GSI 监听、不自己读文件：`gsi.ts` 收到帧 → `noteSnapshot()` → 这里只做两件事
 * （更新内存、必要时落盘）。副屏窗口通过 IPC 读 `currentSnapshot()`，浮层读的还是它自己那份，
 * 两边数据同源。
 *
 * 落盘节奏跟 `gsi-frames-summary.ts` 一样 5 秒一写，但**内容不同**：这里存的是给人看的最近状态，
 * 技能只有等级（冷却每帧在走，写进去就是噪声），所以它比 frames 摘要小得多。
 */
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { logsDir } from './logs/base-dir'
import { emptySnapshot, snapshotOf, type MatchSnapshot } from '@shared/match-snapshot'

const WRITE_EVERY_MS = 5_000

let current: MatchSnapshot = emptySnapshot()
let writtenAt = 0
let pending = false

export function matchSnapshotPath(): string {
  return join(logsDir(), 'match-snapshot.json')
}

export function currentSnapshot(): MatchSnapshot {
  return current
}

/** 每帧调一次（由 `gsi.ts` 的 handleGsiPayload 调）。 */
export function noteSnapshot(payload: Parameters<typeof snapshotOf>[0], at = Date.now()): MatchSnapshot {
  current = snapshotOf(payload, at)
  void flush(false)
  return current
}

async function flush(force: boolean): Promise<void> {
  const now = Date.now()
  if (!force && (now - writtenAt < WRITE_EVERY_MS || pending)) return
  pending = true
  writtenAt = now
  try {
    const file = matchSnapshotPath()
    const temp = file + '.tmp'
    await mkdir(dirname(file), { recursive: true })
    await writeFile(temp, JSON.stringify(current), 'utf8')
    await rename(temp, file)
  } catch {
    // 摘要写不下去不影响对局：不抛、不告警。
  } finally {
    pending = false
  }
}

/** 换局/收场时把最后一份写完（`closeMatch` 调）。 */
export async function flushSnapshot(): Promise<void> {
  await flush(true)
}

/** 探针用：清空内存与落盘节流。 */
export function resetSnapshot(): void {
  current = emptySnapshot()
  writtenAt = 0
  pending = false
}
