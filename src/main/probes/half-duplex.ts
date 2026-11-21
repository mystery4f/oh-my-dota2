/**
 * #129 半双工守卫的探针。
 *
 * 票面三段验收：播放窗口内的录音产出零条识别；30 秒往返不会把同一句连着识别两次；
 * 丢弃次数进日志，「全丢了」和「一次没丢」可区分。全部用合成帧 + 注入时钟，不占真麦克风、不加真实合成调用。
 */
import {
  HALF_DUPLEX_GRACE_MS,
  expireWindow,
  extendPlaybackWindow,
  halfDuplexLine,
  judgeHalfDuplex,
  resolvePlaybackLeg
} from '@shared/half-duplex'
import {
  endPlayback,
  halfDuplexSnapshot,
  judgeCaptureAt,
  lastHalfDuplexDropAt,
  notePlayback,
  resetHalfDuplexForProbe
} from '../services/voice/half-duplex'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logsDir } from '../services/logs/base-dir'
import { reportChainTiming, ChainTimer } from '../services/voice/chain-timing'
import { transcribeForVoice } from '../services/voice/asr'
import { finishProbe, probeCases } from './harness'

export async function runHalfDuplexProbe(): Promise<void> {
  const { cases, push } = probeCases()

  // —— 纯规则 ——
  push('没有播放窗口：录音照常识别', judgeHalfDuplex({ playingUntil: null, now: 1000 }).drop === false)
  push(
    '播放窗口内：丢弃并带上剩余毫秒',
    (() => {
      const verdict = judgeHalfDuplex({ playingUntil: 2000, now: 1500 })
      return verdict.drop && verdict.reason === 'playback' && verdict.untilMs > 0
    })()
  )
  push(
    '窗口结束但还在尾巴里：仍然丢',
    judgeHalfDuplex({ playingUntil: 1000, now: 1000 + HALF_DUPLEX_GRACE_MS - 1 }).drop === true
  )
  push(
    '尾巴也过了：立刻放行',
    judgeHalfDuplex({ playingUntil: 1000, now: 1000 + HALF_DUPLEX_GRACE_MS }).drop === false
  )
  push('关掉守卫时不丢（同传没开也不该有额外行为）', judgeHalfDuplex({ playingUntil: 2000, now: 1500, enabled: false }).drop === false)
  push('窗口只延长不缩短', extendPlaybackWindow(5000, 1000, 3000) === 5000 && extendPlaybackWindow(null, 1000, 3000) === 4000)
  push('到期的窗口归零，不留旧窗口', expireWindow(900, 1000) === null && expireWindow(900, 800) === 900)

  // —— 记账面：丢弃与总数可区分 ——
  resetHalfDuplexForProbe()
  notePlayback(0, 2000)
  const inside = judgeCaptureAt(1200)
  const outside = judgeCaptureAt(3000)
  const snap = halfDuplexSnapshot(3000)
  push('窗口内的录音被丢弃，并给出可读原因', inside.drop && (inside.error ?? '').includes('回声'))
  push('窗口外的录音放行', outside.drop === false)
  push('丢弃与尝试都记了账', snap.dropped === 1 && snap.total === 2, `dropped=${snap.dropped} total=${snap.total}`)
  push('最近一次丢弃有时刻', lastHalfDuplexDropAt() === 1200, String(lastHalfDuplexDropAt()))
  push('「一次没丢」与「丢了 N 次」的文案不一样', halfDuplexLine(0, 3) !== halfDuplexLine(2, 3) && halfDuplexLine(0, 0).includes('还没识别过'))

  // —— 30 秒往返：播放期内的录音产出零条识别，且不会把同一句念回来的话再识别一遍 ——
  resetHalfDuplexForProbe()
  const transcriptions: string[] = []
  const spoken = ['推中路', '小心肉山', '撤一下']
  let clock = 0
  for (const line of spoken) {
    // 这句话播 1.5 秒
    notePlayback(clock, 1500)
    // 播放期间，游戏的麦克风把我们的输出录了回来
    const echo = judgeCaptureAt(clock + 300)
    if (!echo.drop) transcriptions.push(line)
    clock += 1500 + HALF_DUPLEX_GRACE_MS
    // 窗口过后，真实的用户说话被识别一次
    const real = judgeCaptureAt(clock + 100)
    if (!real.drop) transcriptions.push(`用户:${line}`)
    clock += 2000
  }
  push(
    '播放期内的回声一段都没被识别',
    transcriptions.every((item) => !spoken.includes(item)) && transcriptions.length === spoken.length,
    transcriptions.join(' | ')
  )
  push(
    '往返 30 秒内没有同一句连着识别两次',
    transcriptions.every((item, index) => index === 0 || transcriptions[index - 1] !== item),
    transcriptions.join(' | ')
  )
  push('账面上丢了几次写得出来', halfDuplexSnapshot(clock).dropped === spoken.length, halfDuplexSnapshot(clock).line)

  // —— 计数必须进 logs/voice-chain.jsonl：只在控制台等于没记（打包版没人看控制台）——
  const before = halfDuplexSnapshot(clock)
  reportChainTiming(new ChainTimer(null, {}), { spoken: false, stage: 'voice-out', engine: null, chars: 4, segments: 0, mic: '' })
  const chainFile = join(logsDir(), 'voice-chain.jsonl')
  let lastRecord: Record<string, unknown> | null = null
  try {
    const rows = readFileSync(chainFile, 'utf8').trim().split(String.fromCharCode(10))
    lastRecord = JSON.parse(rows[rows.length - 1] ?? '{}')
  } catch {
    lastRecord = null
  }
  const counted = (lastRecord?.halfDuplex ?? null) as { total?: number; dropped?: number } | null
  push(
    '链记录带上当晚的半双工计数',
    counted !== null && counted.dropped === before.dropped && counted.total === before.total,
    counted === null ? '(记录里没有 halfDuplex)' : `dropped=${counted.dropped} total=${counted.total}`
  )
  push('快照有给人看的那一句', halfDuplexSnapshot(clock).line.length > 0, halfDuplexSnapshot(clock).line)
  // —— 生产调用点（#129 被测试退回的那条）——
  // 上面几条都直接调 judgeCaptureAt，所以「真正的入口没回报播放」「丢弃不进日志」这两种坏法
  // 一条都不会红。这里走一次 transcribeForVoice：它必须自己挡住，并留下可查的账。
  resetHalfDuplexForProbe()
  const now = Date.now()
  notePlayback(now, 2000)
  const dropped = await transcribeForVoice('UklGRg==')
  push('走真入口：播放期的录音被挡住', dropped.ok === false && /回声|丢弃/.test(dropped.error ?? ''), dropped.error ?? '')
  push('走真入口：识别尝试计入总数', halfDuplexSnapshot().total === 1 && halfDuplexSnapshot().dropped === 1)

  let logged: string[] = []
  try {
    logged = readFileSync(join(logsDir(), 'voice-chain.jsonl'), 'utf8').split(String.fromCharCode(10))
  } catch {
    logged = []
  }
  const rows = logged.filter((line) => line.includes('half-duplex-drop'))
  push('丢弃进 voice-chain.jsonl，不只进 console（收工后查得了）', rows.length === 1, `rows=${rows.length}`)
  push(
    '那一行带 dropped 与 total，能看出丢了几段',
    rows.length === 1 && /"dropped":1/.test(rows[0]) && /"total":1/.test(rows[0]),
    rows[0] ?? ''
  )

  // —— #157：公告腿与回放腿也是我们自己的声音 ——
  // 这两条腿在渲染层播，主进程只能靠 voice:playback 上报；上报里带腿名，丢弃行才分得清是谁在响。
  const dropRows = (): string[] => {
    try {
      return readFileSync(join(logsDir(), 'voice-chain.jsonl'), 'utf8')
        .split(String.fromCharCode(10))
        .filter((line) => line.includes('half-duplex-drop'))
    } catch {
      return []
    }
  }

  resetHalfDuplexForProbe()
  const announceAt = Date.now()
  notePlayback(announceAt, 1500, 'announce')
  const announceDrop = await transcribeForVoice('UklGRg==')
  const announceRow = dropRows().filter((line) => line.includes('"stage":"announce"')).pop() ?? ''
  push('公告腿窗口内的录音被丢（不再绕过守卫）', announceDrop.ok === false, announceDrop.error ?? '')
  push(
    '丢弃行写明是公告那条腿、并带上窗口剩余毫秒与来源',
    announceRow.includes('"stage":"announce"') && /"penaltyMs":[1-9]/.test(announceRow) && announceRow.includes('"source":"mic"'),
    announceRow
  )

  resetHalfDuplexForProbe()
  notePlayback(Date.now(), 1500, 'echo')
  const echoDrop = await transcribeForVoice('UklGRg==')
  const echoRow = dropRows().filter((line) => line.includes('"stage":"echo"')).pop() ?? ''
  push('同传回放窗口内的录音被丢', echoDrop.ok === false, echoDrop.error ?? '')
  push('两段丢弃在日志里分得清是哪条腿', echoRow.includes('"stage":"echo"'), echoRow)

  resetHalfDuplexForProbe()
  const endAt = Date.now()
  notePlayback(endAt, 5000, 'announce')
  endPlayback('announce')
  const afterEnd = judgeCaptureAt(endAt)
  push('播完立刻关窗：窗口结束后不残留惩罚', afterEnd.drop === false && afterEnd.penaltyMs === 0, String(afterEnd.penaltyMs))
  push('关窗后那一段的腿名也清掉了', halfDuplexSnapshot(endAt).leg === 'unknown')

  // —— #163：两条过去「隐形」的情形 ——
  push('测试模式报 test，不借用 reply（耳验「只认真公告」靠这条）', resolvePlaybackLeg('reply', true) === 'test')
  push('非测试模式原样保留腿名', resolvePlaybackLeg('echo', false) === 'echo')
  push('认不出的腿名仍是 unknown（不把脏值写进日志）', resolvePlaybackLeg('whatever', false) === 'unknown')

  resetHalfDuplexForProbe()
  const beforeSkip = halfDuplexSnapshot(Date.now())
  const skipFile = join(logsDir(), 'voice-chain.jsonl')
  const skipBefore = existsSync(skipFile) ? readFileSync(skipFile, 'utf8').length : 0
  // 时长没量到：过去窗口不开、日志零行；现在要留一行痕迹但不计入总数
  notePlayback(Date.now(), 0, 'test')
  const afterSkip = halfDuplexSnapshot(Date.now())
  push('时长没量到：窗口不开（这段录音不会被丢）', judgeCaptureAt(Date.now()).drop === false)
  push('时长没量到：也不计入识别尝试总数', afterSkip.total === beforeSkip.total, `${beforeSkip.total}→${afterSkip.total}`)
  const skipAdded = existsSync(skipFile) ? readFileSync(skipFile, 'utf8').slice(skipBefore) : ''
  push('时长没量到：日志里留了 half-duplex-skip 一行', skipAdded.includes('"kind":"half-duplex-skip"'), skipAdded.trim().slice(0, 140))
  push('那一行说得出是哪条腿（stage）', skipAdded.includes('"stage":"test"'), skipAdded.trim().slice(0, 140))
  push('那一行明确写了 durationMs 为 null', skipAdded.includes('"durationMs":null'))

  // 端到端：测试音在响的那段录音，丢弃行里的 stage 必须是 test
  resetHalfDuplexForProbe()
  const testAt = Date.now()
  notePlayback(testAt, 3000, resolvePlaybackLeg('reply', true))
  const drop = judgeCaptureAt(testAt + 100)
  push('端到端：测试音期间录音被丢，且腿名是 test', drop.drop === true && drop.leg === 'test', `${drop.drop}/${drop.leg}`)

  finishProbe('HALF_DUPLEX_PROBE', cases)
}
