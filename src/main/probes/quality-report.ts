/**
 * 周度质量卡探针（#110）：两份 jsonl 的文本直接喂纯缝，外加一次「日志目录里真没这两份文件」的走盘。
 *
 * 锁四条：
 * - 票面的验收线：a 干净守卫日志（0 行）与 a 脏行混进去都不会抛，数字照行数算；
 * - 「逐行对得上」：守卫 3 行 = 拦下 3、救回 2、退回原文 1；快照取最新一行的四个数；
 * - 「不许暗示漏检率」：文案里一个百分号、一个「率」字都不许出现在守卫那段；
 * - 空目录显示 0 而不是报错（文件不存在 = 全 0，不返回 null、不抛）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cacheLine, guardLine, qualityFootnote, qualityReportOf, summarizeCacheSnapshots } from '@shared/quality-report'
import { setLogsDirForProbe } from '../services/logs/base-dir'
import { readQualityReport } from '../services/session/quality-report'
import { finishProbe, probeCases } from './harness'

const GUARD_LOG = [
  { at: '2026-01-01T00:00:01.000Z', via: 'session', direction: 'en-zh', tokens: ['bkb'], retryTokens: [], outcome: 'recovered' },
  { at: '2026-01-01T00:00:02.000Z', via: 'session', direction: 'en-zh', tokens: ['bkb', 'gg'], retryTokens: ['bkb'], outcome: 'recovered' },
  { at: '2026-01-01T00:00:03.000Z', via: 'direct', direction: 'zh-en', tokens: ['gank'], retryTokens: ['gank'], outcome: 'gaveup' }
]
  .map((row) => JSON.stringify(row))
  .join('\n')

const CACHE_LOG = [
  { at: '2026-01-01T00:00:00.000Z', pairs: 100, lifetimeHits: 400, hitRatio: 0.8, sessionHits: 4, sessionMisses: 6, writes: 4, evicted: 0, persisted: 0 },
  { at: '2026-01-01T00:01:00.000Z', pairs: 128, lifetimeHits: 512, hitRatio: 0.8, sessionHits: 12, sessionMisses: 8, writes: 4, evicted: 0, persisted: 0 }
]
  .map((row) => JSON.stringify(row))
  .join('\n')

export async function runQualityReportProbe(): Promise<void> {
  const { cases, push: check } = probeCases()

  // —— 空日志：全 0，不抛 ——
  const empty = qualityReportOf({})
  check(
    '空日志给 0 而不是报错：守卫与记账本都在，数字全 0',
    empty.guard.caught === 0 && empty.guard.recovered === 0 && empty.guard.gaveUp === 0 && empty.cache.snapshots === 0,
    JSON.stringify(empty)
  )
  check('空日志的命中占比是 0，不是 NaN', empty.cache.sessionRatio === 0, String(empty.cache.sessionRatio))

  // —— 守卫：行数就是拦下的次数 ——
  const full = qualityReportOf({ guardText: GUARD_LOG, cacheText: CACHE_LOG })
  check(
    '守卫三行 = 拦下 3 次 · 救回 2 · 退回原文 1',
    full.guard.caught === 3 && full.guard.recovered === 2 && full.guard.gaveUp === 1,
    JSON.stringify(full.guard)
  )
  check('守卫的 token 榜是同一份口径（bkb 两次在前）', full.guard.tokens[0]?.token === 'bkb' && full.guard.tokens[0]?.count === 2, JSON.stringify(full.guard.tokens))

  // —— 快照：取最新一行，累计与本次运行两套数分开 ——
  check(
    '记账本取最新一行的累计数（128 对 / 累计白拿 512）',
    full.cache.pairs === 128 && full.cache.lifetimeHits === 512,
    `${full.cache.pairs} / ${full.cache.lifetimeHits}`
  )
  check(
    '本次运行白拿 12 次 · 现翻 8 次',
    full.cache.sessionHits === 12 && full.cache.sessionMisses === 8,
    `${full.cache.sessionHits} / ${full.cache.sessionMisses}`
  )
  check('命中占比 = 12/(12+8) = 0.6', full.cache.sessionRatio === 0.6, String(full.cache.sessionRatio))

  // —— 脏行：半截快照、坏 JSON、非对象全丢掉，其余照样算 ——
  const dirty = qualityReportOf({
    guardText: `${GUARD_LOG}\n{"at":"2026-01-01T00:00:09.000Z","via":"sess`,
    cacheText: `${CACHE_LOG}\n{"at":"2026-01-01T00:02:00.000Z","pairs":9\nnot json\n42\n{"pairs":5,"lifetimeHits":5}`
  })
  check(
    '半截行/坏 JSON/非对象一律丢掉，好行照算',
    dirty.guard.caught === 3 && dirty.cache.snapshots === 2 && dirty.cache.pairs === 128,
    `guard=${dirty.guard.caught} snapshots=${dirty.cache.snapshots} pairs=${dirty.cache.pairs}`
  )

  // —— 文案：守卫那段不许带百分号，也不许出现「率」 ——
  const guardText = guardLine(full.guard)
  check('守卫文案是「拦下 3 次 · 救回 2 次 · 退回原文 1 次」', guardText === '拦下 3 次 · 救回 2 次 · 退回原文 1 次', guardText)
  check('守卫文案不带百分号、不含「率」字（没有分母就不许暗示漏检率）', !guardText.includes('%') && !guardText.includes('率'), guardText)
  check('空守卫的文案也照实写 0', guardLine({ caught: 0, recovered: 0, gaveUp: 0, tokens: [] }) === '拦下 0 次 · 救回 0 次 · 退回原文 0 次', guardLine({ caught: 0, recovered: 0, gaveUp: 0, tokens: [] }))
  const cacheText = cacheLine(full.cache)
  check('记账本文案说白拿 12 次 · 现翻 8 次 · 命中占比 60%', cacheText === '本次运行白拿 12 次 · 现翻 8 次 · 命中占比 60%', cacheText)
  check(
    '记账本没有分母时给 0%（不写 NaN、不写 --）',
    cacheLine(summarizeCacheSnapshots([])) === '本次运行白拿 0 次 · 现翻 0 次 · 命中占比 0%',
    cacheLine(summarizeCacheSnapshots([]))
  )
  const note = qualityFootnote(full.cache)
  check('小字里带累计对数与快照次数', note.includes('128 对') && note.includes('2 次快照'), note)
  check('小字写明「只记抓到的」，不暗示漏检', note.includes('不估没抓到的'), note)

  // —— 走盘：两份文件都不存在的目录，读出来还是 0，不抛 ——
  const fakeLogs = mkdtempSync(join(tmpdir(), 'quality-report-'))
  setLogsDirForProbe(fakeLogs)
  try {
    const missing = readQualityReport()
    check(
      '日志文件都不存在时显示 0，不报错',
      missing.guard.caught === 0 && missing.cache.snapshots === 0,
      JSON.stringify(missing)
    )
    writeFileSync(join(fakeLogs, 'translate-cache.jsonl'), `${CACHE_LOG}\n`, 'utf8')
    const onlyCache = readQualityReport()
    check(
      '只有一份日志存在时，另一段照实给 0',
      onlyCache.cache.pairs === 128 && onlyCache.guard.caught === 0,
      `${onlyCache.cache.pairs} / ${onlyCache.guard.caught}`
    )
  } finally {
    setLogsDirForProbe(null)
    rmSync(fakeLogs, { recursive: true, force: true })
  }

  finishProbe('QUALITY_REPORT_PROBE', cases)
}
