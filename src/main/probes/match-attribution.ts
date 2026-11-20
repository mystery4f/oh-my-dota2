import { exitProbe } from './harness'
import { app } from 'electron'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import type { GsiPayload } from '../services/gsi'
import {
  MATCH_ATTRIBUTION_TTL_MS,
  liveMatchId,
  noteLiveMatch,
  resetLiveMatch
} from '../services/gsi-match'
import { archiveName, pickPrunable, pruneSummaries, archiveSummary, SUMMARY_KEEP } from '../services/gsi-summary-archive'
import {
  flushFrameSummary,
  gsiSummaryArchiveDir,
  gsiSummaryPath,
  recordFrameSummary,
  resetFrameSummary
} from '../services/gsi-frames-summary'
import { setLogsDirForProbe } from '../services/logs/base-dir'
import { ChainTimer, reportChainTiming } from '../services/voice/chain-timing'

/**
 * 归属探针（--match-attribution-probe）：不动游戏、不连 GSI。
 *
 * 钉三件事：一局一份归档（两局两个文件、活文件只装当前局）、对讲行上那个 matchid
 * （对局中写得出、GSI 断了写 null 而不是猜上次那个）、以及保留上限与「当前局永不删」。
 */

interface Row {
  name: string
  ok: boolean
  detail: string
}

const cases: Row[] = []

function push(name: string, ok: boolean, detail: string): void {
  cases.push({ name, ok, detail })
}

function frame(matchid: string): GsiPayload {
  return { map: { matchid, game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS' } } as GsiPayload
}

export async function runMatchAttributionProbe(): Promise<void> {
  // —— 归属：只认活着的帧 ——
  resetLiveMatch()
  push('从没收到帧：liveMatchId() 是 null（菜单里写的行不该挂上一局的 id）', liveMatchId() === null, String(liveMatchId()))
  const t0 = 1_700_000_000_000
  noteLiveMatch('9000000001', t0)
  push(
    `收到帧后 90 秒内都算这一局（TTL=${MATCH_ATTRIBUTION_TTL_MS} ms）`,
    liveMatchId(t0 + MATCH_ATTRIBUTION_TTL_MS - 1) === '9000000001',
    String(liveMatchId(t0 + MATCH_ATTRIBUTION_TTL_MS - 1))
  )
  push(
    '超过 TTL 没有新帧 → null（游戏关了、GSI 断了，不认上一次的 id）',
    liveMatchId(t0 + MATCH_ATTRIBUTION_TTL_MS + 1) === null,
    String(liveMatchId(t0 + MATCH_ATTRIBUTION_TTL_MS + 1))
  )
  noteLiveMatch('', t0)
  push('不带 matchid 的脏帧不覆盖已知归属', liveMatchId(t0) === '9000000001', String(liveMatchId(t0)))
  resetLiveMatch()
  push('resetLiveMatch() 之后什么都不知道', liveMatchId() === null, String(liveMatchId()))

  // —— 归档文件名：脏 id 不许跑出目录 ——
  push('归档文件名只留安全字符', archiveName('../../etc/passwd') === 'etcpasswd.json', archiveName('../../etc/passwd'))
  push('空 matchid 没有文件名（不归档）', archiveName('') === '' && archiveName('///') === '', archiveName('///'))
  push('数字 id 原样保留', archiveName('9061130332') === '9061130332.json', archiveName('9061130332'))
  push(`保留份数上限是 ${SUMMARY_KEEP} 份（写死在代码里，不是随手一个数）`, SUMMARY_KEEP === 20, String(SUMMARY_KEEP))

  // —— 该删哪些：纯函数 ——
  const many = Array.from({ length: 25 }, (_unused, index) => `${9000000000 + index}.json`)
  const pruned = pickPrunable([...many, 'extra.txt'], SUMMARY_KEEP, many[many.length - 1].replace('.json', ''))
  push('25 份只删最老的 5 份（文件名不是 .json 的一律不碰）', pruned.length === 5 && !pruned.includes('extra.txt'), JSON.stringify(pruned))
  push(
    '当前这一局永远不在删除名单里（哪怕它是最老的）',
    !pruned.includes(many[many.length - 1]) && pickPrunable(many, 1, '9000000000').every((name) => name !== '9000000000.json'),
    JSON.stringify(pickPrunable(many, 1, '9000000000'))
  )
  push(
    "排序按数字不是字符串（'99' 不老于 '100'）",
    pickPrunable(['100.json', '99.json'], 1, '100').join() === '99.json',
    JSON.stringify(pickPrunable(['100.json', '99.json'], 1, '100'))
  )

  // —— 磁盘：归档两份、裁剪、当前局不丢 ——
  const dir = mkdtempSync(join(tmpdir(), 'gsi-archive-'))
  try {
    archiveSummary(dir, '9000000001', { matchid: '9000000001', frames: 3 })
    archiveSummary(dir, '9000000002', { matchid: '9000000002', frames: 5 })
    const first = JSON.parse(readFileSync(join(dir, '9000000001.json'), 'utf8')) as { matchid?: string }
    push('两局两个文件、各带自己的 matchid', first.matchid === '9000000001', JSON.stringify(first))
    for (let index = 0; index < SUMMARY_KEEP + 3; index += 1) writeFileSync(join(dir, `80000000${index}.json`), '{}')
    // 目录里此刻 25 份（两份真归档 + 23 份占位）：留 20 份，最老的 5 份该被删。
    const removed = pruneSummaries(dir, '9000000002')
    const left = readdirSync(dir).filter((name) => name.endsWith('.json')).length
    push(
      `裁剪把 25 份收到 ${SUMMARY_KEEP} 份（removed=${removed.length}）`,
      removed.length === 25 - SUMMARY_KEEP && left === SUMMARY_KEEP,
      `removed=${removed.length} left=${left}`
    )
    push(
      '当前局那份裁剪后还在（它最新，本来就不该被删）',
      existsSync(join(dir, '9000000002.json')),
      ''
    )
    push(
      '当前局即使是最老的一份也不删（keep=1、当前是 1）',
      pickPrunable(['1.json', '2.json'], 1, '1').length === 0 && pickPrunable(['1.json', '2.json'], 1, '2').join() === '1.json',
      JSON.stringify([pickPrunable(['1.json', '2.json'], 1, '1'), pickPrunable(['1.json', '2.json'], 1, '2')])
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  // —— 活文件 / 对讲日志：全部写进假数据目录，真实 logs/ 一个字节都不碰（#126）——
  // 探针写的都是合成的：留在真实目录里，下一局会把假 matchid 当上一局归档，
  // 而且这里的清场写文件会把用户真实的对讲历史截成空。改指向 mkdtemp 出来的目录。
  const realLogsDir = join(app.getPath('userData'), 'logs')
  const realSummaryFile = join(realLogsDir, 'gsi-summary.json')
  const realVoiceFile = join(realLogsDir, 'voice-chain.jsonl')
  const readOrEmpty = (path: string): string => (existsSync(path) ? readFileSync(path, 'utf8') : '')
  const realSummaryBefore = readOrEmpty(realSummaryFile)
  const realVoiceBefore = readOrEmpty(realVoiceFile)
  const fakeLogs = mkdtempSync(join(tmpdir(), 'match-attribution-logs-'))
  setLogsDirForProbe(fakeLogs)
  try {
    // —— 活文件只装当前局：真走 recordFrameSummary 两局 ——
    resetFrameSummary()
    recordFrameSummary(frame('9100000001'))
    recordFrameSummary(frame('9100000001'))
    flushFrameSummary()
    recordFrameSummary(frame('9100000002'))
    recordFrameSummary(frame('9100000002'))
    flushFrameSummary()
    const live = JSON.parse(readFileSync(gsiSummaryPath(), 'utf8')) as { matchid?: string | null; frames?: number }
    push('活文件只装最后一局（matchid 跟着换、帧数不累加）', live.matchid === '9100000002' && live.frames === 2, JSON.stringify(live))
    const archiveDir = gsiSummaryArchiveDir()
    const archived = JSON.parse(readFileSync(join(archiveDir, '9100000001.json'), 'utf8')) as { matchid?: string }
    push('上一局在归档里各有一份、内容还是它自己那局', archived.matchid === '9100000001', JSON.stringify(archived))
    push('假目录真的接住了这两局（活文件与归档都在临时目录里）', existsSync(join(fakeLogs, 'gsi-summary.json')) && existsSync(join(archiveDir, '9100000002.json')), fakeLogs)

    // —— 对讲行上的 matchid ——
    const logFile = join(fakeLogs, 'voice-chain.jsonl')
    writeFileSync(logFile, JSON.stringify({ keep: true }) + '\n')
    noteLiveMatch('9200000001')
    const timer = new ChainTimer(null)
    timer.noteTranslated()
    timer.noteFirstAudio()
    timer.notePlayStart()
    reportChainTiming(timer, { spoken: true, stage: null, engine: 'probe-marker', chars: 2, segments: 1, mic: '' })
    let row = JSON.parse(readFileSync(logFile, 'utf8').trim().split('\n').pop() ?? '{}') as { matchid?: string | null }
    push('对局中写的行带 matchid', row.matchid === '9200000001', String(row.matchid))

    resetLiveMatch()
    reportChainTiming(timer, { spoken: true, stage: null, engine: 'probe-marker', chars: 2, segments: 1, mic: '' })
    row = JSON.parse(readFileSync(logFile, 'utf8').trim().split('\n').pop() ?? '{}') as { matchid?: string | null }
    push('GSI 断了写的行是显式 null（不猜上一个 id、也不是缺字段）', 'matchid' in row && row.matchid === null, JSON.stringify(row))
  } finally {
    setLogsDirForProbe(null)
    resetFrameSummary()
    rmSync(fakeLogs, { recursive: true, force: true })
  }
  push(
    '探针过后真实 gsi-summary.json 逐字节没变（假对局没漏进活文件）',
    readOrEmpty(realSummaryFile) === realSummaryBefore,
    `${realSummaryBefore.length} → ${readOrEmpty(realSummaryFile).length} bytes`
  )
  push(
    '探针过后真实 voice-chain.jsonl 没被写、也没被截断（行数与内容都不变）',
    readOrEmpty(realVoiceFile) === realVoiceBefore && !readOrEmpty(realVoiceFile).includes('probe-marker'),
    `${realVoiceBefore.split('\n').filter(Boolean).length} → ${readOrEmpty(realVoiceFile).split('\n').filter(Boolean).length} 行`
  )

  const failed = cases.filter((item) => !item.ok)
  for (const item of cases) console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}  (${item.detail})`)
  console.log('MATCH_ATTRIBUTION_PROBE', JSON.stringify({ ok: failed.length === 0, passed: cases.length - failed.length, failed: failed.length }))
  exitProbe(failed.length === 0)
}
