import { appendFileSync, existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

/**
 * 带容量上限的 JSONL 追加（与 logs/gsi-chat.jsonl 同一套做法）。
 *
 * 日志是排障用的证据，不能让它在跑了一整晚之后把磁盘吃穿；也不能让「写日志」这件事
 * 失败到影响主流程——目录被删、磁盘满，都只是这一行少了一条记录。
 * 超过上限时整份清空重写：留下的是「最近这一箱」，不是永久历史。
 */
const sizes = new Map<string, number>()

export function appendCappedJsonl(path: string, record: Record<string, unknown>, maxBytes = 256 * 1024): void {
  try {
    const line = `${JSON.stringify(record)}\n`
    let size = sizes.get(path)
    if (size === undefined) size = existsSync(path) ? statSync(path).size : 0
    if (size > maxBytes) {
      writeFileSync(path, '')
      size = 0
    }
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, line, 'utf8')
    sizes.set(path, size + Buffer.byteLength(line))
  } catch {
    // 日志写不进去不能影响对讲本身。
  }
}
