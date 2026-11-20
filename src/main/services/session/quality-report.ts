/**
 * 周度质量卡的读数：把两份 jsonl 读出来交给纯缝算。
 *
 * 两份文件都是「有就写、没有就没有」的证据日志——第一次装完还没翻过一句时它们根本不存在。
 * 所以这里读失败一律当空文本：卡片显示 0，不显示错误（#110 的验收项）。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { qualityReportOf, type QualityReport } from '@shared/quality-report'
import { logsDir } from '../logs/base-dir'

/** 守卫违例（`guard-telemetry.ts` 攒批写）；一局里正常译文一行都不写。 */
function guardLogPath(): string {
  return join(logsDir(), 'translate-guard.jsonl')
}

/** 记账本快照（`snapshotTranslationStats()` 每 60 秒一行）。 */
function cacheLogPath(): string {
  return join(logsDir(), 'translate-cache.jsonl')
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return ''
  }
}

/** 面板那张卡的全部数字。每次调用现读现算，不缓存：日志本身就是最新的那份。 */
export function readQualityReport(): QualityReport {
  return qualityReportOf({ guardText: readText(guardLogPath()), cacheText: readText(cacheLogPath()) })
}
