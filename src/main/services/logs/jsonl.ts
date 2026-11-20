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
  appendCappedJsonlMany(path, [record], maxBytes)
}

/**
 * 一批整写成一次 append：热路径上一句一次 `appendFileSync` 是拿磁盘延迟换一条日志，
 * 攒够一批再落盘，调用方（守卫遥测）才有资格说自己「不拖慢翻译」。
 */
export function appendCappedJsonlMany(
  path: string,
  records: readonly object[],
  maxBytes = 256 * 1024
): void {
  if (records.length === 0) return
  try {
    const kept = fittingTail(records.map((record) => `${JSON.stringify(record)}\n`), maxBytes)
    const bytes = kept.reduce((sum, line) => sum + Buffer.byteLength(line), 0)
    let size = sizes.get(path)
    if (size === undefined) size = existsSync(path) ? statSync(path).size : 0
    if (size + bytes > maxBytes) {
      writeFileSync(path, '')
      size = 0
    }
    mkdirSync(dirname(path), { recursive: true })
    appendFileSync(path, kept.join(''), 'utf8')
    sizes.set(path, size + bytes)
  } catch {
    // 日志写不进去不能影响对讲本身。
  }
}

/**
 * 一批自己就超过上限时，留下**最新的**那几条能装下的：日志的价值在「最近发生了什么」，
 * 一批攒着把整份清空重写、写出一个仍然超限的文件，等于上限形同虚设。
 */
function fittingTail(lines: readonly string[], maxBytes: number): string[] {
  const kept: string[] = []
  let bytes = 0
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const size = Buffer.byteLength(lines[index])
    // 上限比一条记录还小时仍留最新那条：丢证据比越线更糟。
    if (bytes + size > maxBytes && kept.length > 0) break
    bytes += size
    kept.unshift(lines[index])
  }
  return kept
}
