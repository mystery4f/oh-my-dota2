import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 按局归档 GSI 小结：一局一份文件，谁也别把两局压进同一个故事。
 *
 * 为什么不能只留一份：`gsi-summary.json` 是「当下这一局」的活文件，换局就清账；
 * POST_GAME 之后确实落了一次，但只要下一局开打，上一局那份就被覆盖了。
 * 复盘页要一晚上几局的连续记录，所以这里按 matchid 各存一份，只留最新的几份。
 */

/** 留几份。一局一份、几 KB，留 20 局够一晚上复盘；再多也没人翻。 */
export const SUMMARY_KEEP = 20

/** matchid 直接进文件名，只留安全字符：脏 id 不许把文件写到目录外面去。 */
export function archiveName(matchId: string): string {
  const safe = matchId.replace(/[^0-9A-Za-z_-]/g, '')
  return safe.length > 0 ? `${safe}.json` : ''
}

/**
 * 该删哪些（纯函数，探针直接钉它）。
 * 规则：按 matchid 从新到旧留 `keep` 份；当前这一局永远不删，
 * 当前局不在已存在的清单里就只是不多删一份。
 */
export function pickPrunable(existing: readonly string[], keep: number, currentMatchId: string): string[] {
  const names = existing.filter((name) => name.endsWith('.json')).map((name) => name.slice(0, -5))
  const current = archiveName(currentMatchId).replace(/\.json$/, '')
  // matchid 是数字串：长的更大，同长比字典序。不能按字符串排（'99' > '100'）。
  const ordered = [...names].sort((a, b) => (a.length === b.length ? b.localeCompare(a) : b.length - a.length))
  const doomed = new Set(ordered.slice(Math.max(keep, 0)))
  doomed.delete(current)
  return [...doomed].map((name) => `${name}.json`)
}

export function archiveSummary(dir: string, matchId: string, payload: Record<string, unknown>): string | null {
  const name = archiveName(matchId)
  if (name.length === 0) return null
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  const temp = file + '.tmp'
  writeFileSync(temp, JSON.stringify(payload, null, 2), 'utf8')
  renameSync(temp, file)
  return file
}

/** 删掉超出保留份数的归档，当前这一局永不删。返回真删掉的文件名。 */
export function pruneSummaries(dir: string, currentMatchId: string, keep: number = SUMMARY_KEEP): string[] {
  if (!existsSync(dir)) return []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return []
  }
  const removed: string[] = []
  for (const name of pickPrunable(names, keep, currentMatchId)) {
    try {
      rmSync(join(dir, name))
      removed.push(name)
    } catch {
      // 删不掉就留着：少一份归档比报错好，下一局还会再试一次。
    }
  }
  return removed
}
