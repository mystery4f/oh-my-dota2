/**
 * #129 半双工守卫的探针。
 *
 * 票面三段验收：播放窗口内的录音产出零条识别；30 秒往返不会把同一句连着识别两次；
 * 丢弃次数进日志，「全丢了」和「一次没丢」可区分。全部用合成帧 + 注入时钟，不占真麦克风、不加真实合成调用。
 */
import { HALF_DUPLEX_GRACE_MS, expireWindow, extendPlaybackWindow, halfDuplexLine, judgeHalfDuplex } from '@shared/half-duplex'
import {
  halfDuplexSnapshot,
  judgeCaptureAt,
  lastHalfDuplexDropAt,
  notePlayback,
  resetHalfDuplexForProbe
} from '../services/voice/half-duplex'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { logsDir } from '../services/logs/base-dir'
import { reportChainTiming, ChainTimer } from '../services/voice/chain-timing'
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

  finishProbe('HALF_DUPLEX_PROBE', cases)
}
