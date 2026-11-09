import { app } from 'electron'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { formatChainTiming, formatChainTotal, formatMs } from '@shared/voice-timing'
import { appendCappedJsonl } from '../services/logs/jsonl'
import { ChainTimer, noteAsrRun, reportChainTiming, takeAsrRun } from '../services/voice/chain-timing'

/**
 * 对讲计时探针（--voice-chain-probe）：只验计时的「账」，不转录、不合成、不开游戏。
 *
 * 这条链慢的时候最怕数字说谎：缺一段被写成 0、总计把识别漏掉、识别记录被下一句抢走。
 * 这里把它们逐条钉死：缺段是 null、总计含识别、重复打点只认第一次、识别票据领一次就没了、
 * 超过 60 秒的识别不再算本句，以及 jsonl 日志既有容量上限又不会因此丢最后一条。
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

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function runVoiceChainProbe(): Promise<void> {
  // —— 计时形状：缺段是 null，不是 0 ——
  noteAsrRun(Date.now() - 500, 120)
  const partial = new ChainTimer(takeAsrRun()).timing()
  push(
    '只记了识别：其余段全 null（没量到不等于 0 毫秒），总计也还不存在',
    partial.asrMs === 120 &&
      partial.translateMs === null &&
      partial.firstAudioMs === null &&
      partial.playStartMs === null &&
      partial.speakMs === null &&
      partial.totalMs === null,
    JSON.stringify(partial)
  )
  push('领一次就没了：同一句不会被下一句抢走票据', takeAsrRun() === null, 'second take')

  // —— 五段都量到 ——
  noteAsrRun(Date.now() - 4000, 700)
  const asr = takeAsrRun()
  const timer = new ChainTimer(asr)
  await delay(25)
  timer.noteTranslated()
  await delay(25)
  timer.noteFirstAudio()
  await delay(25)
  timer.notePlayStart()
  await delay(25)
  timer.noteSpeakEnd()
  const full = timer.timing()
  push(
    '五段全量到，每段都是非负数',
    [full.translateMs, full.firstAudioMs, full.playStartMs, full.speakMs].every((ms) => ms !== null && ms >= 0),
    JSON.stringify(full)
  )
  push(
    '总计从识别开始算（含 ASR 本身，不是从翻译开始）',
    full.totalMs !== null && full.totalMs >= 700 && full.totalMs > (full.translateMs ?? 0),
    `totalMs=${full.totalMs} asrMs=${full.asrMs} translateMs=${full.translateMs}`
  )
  push('播完 = 起播之后到段落送完', full.speakMs !== null && full.speakMs >= 0, `speakMs=${full.speakMs}`)

  // —— 重复打点只认第一次：晚来的 mark 不能把数字改小 ——
  const repeat = new ChainTimer(null)
  await delay(20)
  repeat.noteTranslated()
  const once = repeat.timing().translateMs
  await delay(30)
  repeat.noteTranslated()
  push('重复打点只认第一次（后到的 mark 不缩短已计的时长）', repeat.timing().translateMs === once, `${once} vs ${repeat.timing().translateMs}`)

  // —— 识别票据的 60 秒有效期：夸口的旧识别不许张贴到本句 ——
  noteAsrRun(Date.now() - 100, 50)
  push('超过 60 秒的识别不算本句', takeAsrRun(Date.now() + 61_000) === null, 'expired')
  noteAsrRun(Date.now() - 100, 50)
  push('60 秒内仍有效', takeAsrRun(Date.now())?.ms === 50, 'fresh')

  // —— 展示：缺段不出现在串里，全缺就不画 ——
  push('formatMs: 缺值画 -', formatMs(null) === '-' && formatMs(undefined) === '-', '-')
  push('formatMs: 一秒以下给毫秒，以上给一位小数秒', formatMs(999) === '999ms' && formatMs(1000) === '1.0s', `${formatMs(999)} / ${formatMs(1000)}`)
  const line = formatChainTiming({ asrMs: 700, translateMs: 1000, firstAudioMs: null, playStartMs: 300, speakMs: null, totalMs: 2000 })
  push(
    'formatChainTiming: 按 识别→译→首音→起播→播完 排，缺段跳过',
    line === '识别 700ms · 译 1.0s · 起播 300ms',
    String(line)
  )
  push(
    'formatChainTiming: 全缺返回 null（那一行就不画）',
    formatChainTiming({ asrMs: null, translateMs: null, firstAudioMs: null, playStartMs: null, speakMs: null, totalMs: null }) === null &&
      formatChainTiming(null) === null,
    'null'
  )
  push('formatChainTotal: 只报识别开始到出声', formatChainTotal(full) === `起播共 ${formatMs(full.totalMs)}`, String(formatChainTotal(full)))
  push('formatChainTotal: 没起播就没有这一句', formatChainTotal(partial) === null, 'null')

  // —— jsonl 日志：有上限，但最后一条永远在 ——
  const dir = mkdtempSync(join(app.getPath('temp'), 'voice-chain-'))
  try {
    const file = join(dir, 'capped.jsonl')
    for (let i = 0; i < 40; i += 1) appendCappedJsonl(file, { i, pad: 'x'.repeat(24) }, 300)
    const text = readFileSync(file, 'utf8')
    const lines = text.trim().split('\n')
    const last = JSON.parse(lines[lines.length - 1]) as { i: number }
    push('appendCappedJsonl: 超过上限整份清空（留下一箱，不是永久历史）', statSync(file).size <= 300 + 64, `bytes=${statSync(file).size}`)
    push('appendCappedJsonl: 清空之后最后一条仍在、且每行都是完整 JSON', last.i === 39 && lines.every((l) => !!JSON.parse(l)), `lines=${lines.length} last=${last.i}`)

    const broken = join(dir, 'nested', 'deep', 'x.jsonl')
    appendCappedJsonl(broken, { ok: true })
    push('appendCappedJsonl: 目录不存在时自己建（不会静默丢一条）', readFileSync(broken, 'utf8').includes('"ok":true'), broken)

    // —— reportChainTiming: 控制台一行 + 文件一行，返回同一份计时 ——
    const logged = new ChainTimer(null)
    logged.noteTranslated()
    logged.noteFirstAudio()
    logged.notePlayStart()
    const returned = reportChainTiming(logged, { spoken: true, stage: null, engine: 'probe-marker', chars: 3, segments: 1 })
    const logFile = join(app.getPath('userData'), 'logs', 'voice-chain.jsonl')
    writeFileSync(logFile, '')
    reportChainTiming(logged, { spoken: true, stage: null, engine: 'probe-marker', chars: 3, segments: 1 })
    const written = readFileSync(logFile, 'utf8')
    push(
      'reportChainTiming: 落一行带引擎/段数与五段计时的 jsonl',
      written.includes('"engine":"probe-marker"') && written.includes('"totalMs"') && written.includes('"segments":1'),
      written.trim().slice(0, 200)
    )
    push('reportChainTiming: 返回的就是这份计时（浮层/面板读同一份）', returned.playStartMs !== null && returned.totalMs !== null, JSON.stringify(returned))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  const failed = cases.filter((item) => !item.ok)
  for (const item of cases) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name} ${item.detail}`)
  }
  console.log(
    `VOICE_CHAIN_PROBE ${JSON.stringify({ ok: failed.length === 0, passed: cases.length - failed.length, failed: failed.length })}`
  )
  app.exit(failed.length > 0 ? 1 : 0)
}
