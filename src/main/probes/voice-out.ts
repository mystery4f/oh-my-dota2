import { app } from 'electron'
import {
  DEFAULT_SINK_ID,
  DEFAULT_SPEAK_KEY,
  DEFAULT_VOICE_OUT_VOICE,
  MIN_SPEAK_MS,
  PTT_MARGIN_MS,
  SINK_FALLBACK_HINT,
  VOICE_OUT_TEST_LINE,
  VOICE_OUT_VOICES,
  decideVoiceOutTest,
  normalizeSpeakKey,
  pttWatchdogMs,
  pttWindow,
  resolveOutputSink,
  speakKeyVk,
  type AudioOutputDevice
} from '@shared/voice-out'

/**
 * 声出探针（--voice-out-probe）：只验「脑子」，不碰网络、不碰驱动、不开游戏。
 *
 * 声出链路坏起来最迷惑的是「合成成功但频道里没人听见」——合成、路由、按键三段
 * 各自都在，决策接错了才会哑。这里把三层决策逐条钉死：
 * 念不念/念什么/哪个嗓（decideVoiceOutTest）、输出设备路由（resolveOutputSink）、
 * 说话键时序（pttWindow / pttWatchdogMs / speakKeyVk）。
 * 物理层（VB-Cable 出声、游戏里听到、SendInput 真按键）走人工验收。
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

export function runVoiceOutProbe(): void {
  // —— 决策一：念什么、哪个嗓、念不念 ——
  push('测试句非空且纯 ASCII（合成端最稳）', VOICE_OUT_TEST_LINE.length > 0 && /^[\x20-\x7E]+$/.test(VOICE_OUT_TEST_LINE), VOICE_OUT_TEST_LINE)
  push(
    '默认嗓必须是英文占位嗓，且绝不能混进朗读下拉（EDGE_VOICES）',
    VOICE_OUT_VOICES.some((voice) => voice.id === DEFAULT_VOICE_OUT_VOICE),
    DEFAULT_VOICE_OUT_VOICE
  )

  const okPlan = decideVoiceOutTest(true)
  push('合成成功 → 念', okPlan.speak && okPlan.skip === null, JSON.stringify(okPlan))
  push('念的就是固定测试句', okPlan.text === VOICE_OUT_TEST_LINE.trim(), okPlan.text)
  push('念的是英文占位嗓', okPlan.voice === DEFAULT_VOICE_OUT_VOICE, okPlan.voice)

  const failPlan = decideVoiceOutTest(false)
  push(
    '合成失败（断网/引擎挂）→ 不念，说话键也绝不按',
    !failPlan.speak && failPlan.skip === 'synth-failed' && failPlan.text === '' && failPlan.voice === '',
    JSON.stringify(failPlan)
  )
  const emptyPlan = decideVoiceOutTest(true, '   ')
  push('测试句只剩空白 → 不念', !emptyPlan.speak && emptyPlan.skip === 'empty-line', JSON.stringify(emptyPlan))

  // —— 决策二：输出设备路由 ——
  const devices: AudioOutputDevice[] = [
    { deviceId: 'default', label: '默认' },
    { deviceId: '{cable-0}.0000', label: 'CABLE Input (VB-Audio Virtual Cable)' },
    { deviceId: '{spk-1}.0000', label: '扬声器 (Realtek)' }
  ]
  const emptyChoice = resolveOutputSink('', devices)
  push(
    '没选过设备 → 系统默认输出，不算回退也不提示',
    emptyChoice.sinkId === DEFAULT_SINK_ID && !emptyChoice.fallback && emptyChoice.hint === null,
    JSON.stringify(emptyChoice)
  )
  const wsChoice = resolveOutputSink('   ', devices)
  push('空白等同没选', wsChoice.sinkId === DEFAULT_SINK_ID && !wsChoice.fallback, JSON.stringify(wsChoice))

  const byId = resolveOutputSink('{cable-0}.0000', devices)
  push(
    '按 deviceId 命中（面板下拉存的值）',
    byId.sinkId === '{cable-0}.0000' && byId.label.includes('CABLE Input') && !byId.fallback,
    JSON.stringify(byId)
  )
  const byLabel = resolveOutputSink('扬声器 (Realtek)', devices)
  push(
    '按 label 命中（老配置里手填的设备名）',
    byLabel.sinkId === '{spk-1}.0000' && !byLabel.fallback,
    JSON.stringify(byLabel)
  )
  const missing = resolveOutputSink('{ghost}.9999', devices)
  push(
    '设备不在列表（拔了）→ 回退默认输出 + 明确提示',
    missing.sinkId === DEFAULT_SINK_ID && missing.fallback && missing.hint === SINK_FALLBACK_HINT,
    JSON.stringify(missing)
  )
  const legacyCable = resolveOutputSink('CABLE Input (VB-Audio Virtual Cable)', devices)
  push(
    'VB-Cable 按名字也能路由（手填配置不作废）',
    legacyCable.sinkId === '{cable-0}.0000' && !legacyCable.fallback,
    JSON.stringify(legacyCable)
  )
  const noDevices = resolveOutputSink('{cable-0}.0000', [])
  push('设备列表为空也照样回退，不抛错', noDevices.sinkId === DEFAULT_SINK_ID && noDevices.fallback, JSON.stringify(noDevices))

  // —— 决策三：说话键时序 ——
  const normal = pttWindow(3000)
  push(
    '按住窗口 = 音频 + 头尾各 200ms',
    normal.leadMs === PTT_MARGIN_MS && normal.releaseMs === PTT_MARGIN_MS && normal.holdMs === 3400,
    JSON.stringify(normal)
  )
  const custom = pttWindow(1000, 100)
  push('余量可配（100ms → hold 1200ms）', custom.holdMs === 1200 && custom.leadMs === 100, JSON.stringify(custom))
  const zero = pttWindow(0)
  push(
    '时长为 0 也至少开一小会儿频道',
    zero.holdMs === MIN_SPEAK_MS + PTT_MARGIN_MS * 2,
    JSON.stringify(zero)
  )
  const negative = pttWindow(-50)
  push('负时长同样兜底', negative.holdMs === MIN_SPEAK_MS + PTT_MARGIN_MS * 2, JSON.stringify(negative))
  const unknown = pttWindow(Number.NaN)
  push('NaN 时长兜底不炸', unknown.holdMs === MIN_SPEAK_MS + PTT_MARGIN_MS * 2, JSON.stringify(unknown))
  const badMargin = pttWindow(1000, Number.NaN)
  push('余量 NaN 归位默认 200ms', badMargin.leadMs === PTT_MARGIN_MS && badMargin.holdMs === 1400, JSON.stringify(badMargin))

  const watched = pttWatchdogMs(normal)
  push(
    '松键保险至少是 hold 的两倍 + 4 秒',
    watched >= normal.holdMs * 2 + 4000 && watched >= 5000,
    String(watched)
  )
  const watchedZero = pttWatchdogMs(zero)
  push('最短保险不少于 5 秒', watchedZero === Math.max(5000, zero.holdMs * 2 + 4000), String(watchedZero))
  push(
    '音频越长保险越长（不会反过来掐断长句）',
    pttWatchdogMs(pttWindow(8000)) > watched,
    String(pttWatchdogMs(pttWindow(8000)))
  )

  // —— 决策四：说话键 → VK ——
  push('小写 f5 归一成 F5', normalizeSpeakKey('f5') === 'F5', normalizeSpeakKey('f5'))
  push('带空白的 F12 也认', normalizeSpeakKey('  F12  ') === 'F12', normalizeSpeakKey('  F12  '))
  push('单个字母/数字合法（A/5）', normalizeSpeakKey('a') === 'A' && normalizeSpeakKey('5') === '5', 'a→A, 5→5')
  push(
    '乱填一律打回默认：空串/ctrl/FF/F13',
    normalizeSpeakKey('') === DEFAULT_SPEAK_KEY &&
      normalizeSpeakKey('ctrl') === DEFAULT_SPEAK_KEY &&
      normalizeSpeakKey('FF') === DEFAULT_SPEAK_KEY &&
      normalizeSpeakKey('F13') === DEFAULT_SPEAK_KEY,
    `all→${DEFAULT_SPEAK_KEY}`
  )
  push('非字符串（手编 JSON 的 null）也打回默认', normalizeSpeakKey(null as unknown as string) === DEFAULT_SPEAK_KEY, DEFAULT_SPEAK_KEY)
  push('F5 → 0x74（VK_F5，别和 F6 的 0x75 混了）', speakKeyVk('F5') === 0x74, String(speakKeyVk('F5')))
  push('F1..F12 连续映射 0x70..0x7B', speakKeyVk('F1') === 0x70 && speakKeyVk('F12') === 0x7b, `${speakKeyVk('F1')}..${speakKeyVk('F12')}`)
  push('字母/数字 → ASCII 码（A=65, 5=53）', speakKeyVk('A') === 65 && speakKeyVk('5') === 53, `${speakKeyVk('A')},${speakKeyVk('5')}`)
  push('乱填（经归一化）永远解析得出 VK', speakKeyVk('ctrl') === speakKeyVk(DEFAULT_SPEAK_KEY), String(speakKeyVk('ctrl')))

  const failed = cases.filter((item) => !item.ok)
  for (const item of cases) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name} ${item.detail}`)
  }
  console.log(
    `VOICE_OUT_PROBE ${JSON.stringify({ ok: failed.length === 0, passed: cases.length - failed.length, failed: failed.length })}`
  )
  app.exit(failed.length > 0 ? 1 : 0)
}
