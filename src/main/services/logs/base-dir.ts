import { app } from 'electron'
import { join } from 'node:path'

/**
 * 日志根目录：`<userData>/logs`。
 *
 * 为什么要有这个 override：探针写的每一行都是合成的，落进真实 logs/ 就会被下一局
 * 当成证据（`--match-attribution-probe` 曾把假 matchid 留在 gsi-summary.json、把
 * 真实 voice-chain.jsonl 截成空文件，#126）。探针改指向 mkdtemp 出来的假目录，
 * 业务代码永远拿默认值。
 */
let override: string | null = null

export function logsDir(): string {
  return override ?? join(app.getPath('userData'), 'logs')
}

/** 仅供探针：临时把日志根目录换掉，传 null 恢复默认。 */
export function setLogsDirForProbe(dir: string | null): void {
  override = dir
}
