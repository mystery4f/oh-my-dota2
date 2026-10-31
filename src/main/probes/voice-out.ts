import { app } from 'electron'
import { OFFLINE_VOICES } from '@shared/ipc'
import {
  DEFAULT_SINK_ID,
  DEFAULT_SPEAK_KEY,
  DEFAULT_VOICE_OUT_ENGINE,
  MIN_SPEAK_MS,
  PTT_MARGIN_MS,
  SINK_FALLBACK_HINT,
  VOICE_OUT_TEST_LINE,
  VOICE_OUT_VOICES,
  decideVoiceOutReply,
  decideVoiceOutTest,
  normalizeSpeakKey,
  normalizeVoiceOutEngine,
  pickPlayableSegments,
  pttWatchdogMs,
  pttWindow,
  resolveOutputSink,
  resolveVoiceOutSynth,
  speakKeyVk,
  spokenStatusLine,
  type AudioOutputDevice
} from '@shared/voice-out'
import { splitForSpeech } from '../services/voice/speech'

/**
 * 声出探针（--voice-out-probe）：只验「脑子」，不碰网络、不碰驱动、不开游戏。
 *
 * 声出链路坏起来最迷惑的是「合成成功但频道里没人听见」——合成、路由、按键三段
 * 各自都在，决策接错了才会哑。这里把四层决策逐条钉死：
 * 念不念/念什么/哪个嗓（decideVoiceOutTest）、引擎与音色路由（normalizeVoiceOutEngine /
 * resolveVoiceOutSynth：edge 占位、offline 本地、GV 音色包）、输出设备路由（resolveOutputSink）、
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
  // 票 07 后没有「固定嗓」常量可引用：默认嗓 = 默认引擎经 resolveVoiceOutSynth 解析出的那把。
  const defaultSynth = resolveVoiceOutSynth(DEFAULT_VOICE_OUT_ENGINE, '', VOICE_OUT_TEST_LINE)
  push('测试句非空且纯 ASCII（合成端最稳）', VOICE_OUT_TEST_LINE.length > 0 && /^[\x20-\x7E]+$/.test(VOICE_OUT_TEST_LINE), VOICE_OUT_TEST_LINE)
  push(
    '默认嗓必须是英文占位嗓，且绝不能混进朗读下拉（EDGE_VOICES）',
    VOICE_OUT_VOICES.some((voice) => voice.id === defaultSynth.voice),
    defaultSynth.voice
  )

  const okPlan = decideVoiceOutTest(true)
  push('合成成功 → 念', okPlan.speak && okPlan.skip === null, JSON.stringify(okPlan))
  push('念的就是固定测试句', okPlan.text === VOICE_OUT_TEST_LINE.trim(), okPlan.text)
  push('念的是默认引擎解析出的英文占位嗓', okPlan.voice === defaultSynth.voice, okPlan.voice)

  const failPlan = decideVoiceOutTest(false)
  push(
    '合成失败（断网/引擎挂）→ 不念，说话键也绝不按',
    !failPlan.speak && failPlan.skip === 'synth-failed' && failPlan.text === '' && failPlan.voice === '',
    JSON.stringify(failPlan)
  )
  const emptyPlan = decideVoiceOutTest(true, '   ')
  push('测试句只剩空白 → 不念', !emptyPlan.speak && emptyPlan.skip === 'empty-line', JSON.stringify(emptyPlan))

  // —— 决策一·引擎选择（声出引擎并入三引擎层：edge 占位 / offline 本地 / GV 音色包） ——
  push(
    '默认声出引擎是 edge（英文神经嗓占位，GV 和离线中文嗓都不是默认）',
    DEFAULT_VOICE_OUT_ENGINE === 'edge',
    DEFAULT_VOICE_OUT_ENGINE
  )
  push(
    '引擎名合法值原样通过（edge/offline/sovits）',
    normalizeVoiceOutEngine('edge') === 'edge' &&
      normalizeVoiceOutEngine('offline') === 'offline' &&
      normalizeVoiceOutEngine('sovits') === 'sovits',
    'edge/offline/sovits 原样通过'
  )
  push(
    '乱填一律打回 edge：system/空串/undefined/GV（大写）',
    normalizeVoiceOutEngine('system') === 'edge' &&
      normalizeVoiceOutEngine('') === 'edge' &&
      normalizeVoiceOutEngine(undefined) === 'edge' &&
      normalizeVoiceOutEngine('GV') === 'edge',
    'all→edge'
  )

  const edgeSynth = resolveVoiceOutSynth('edge', 'en-US-AnaNeural', VOICE_OUT_TEST_LINE)
  push(
    'edge 引擎按选择出英文神经嗓，mp3',
    edgeSynth.engine === 'edge' &&
      edgeSynth.voice === 'en-US-AnaNeural' &&
      edgeSynth.audioMime === 'audio/mpeg',
    JSON.stringify(edgeSynth)
  )
  const edgeFallback = resolveVoiceOutSynth('edge', 'zh-CN-YunxiNeural', VOICE_OUT_TEST_LINE)
  push(
    'edge 引擎音色不在声出清单里 → 打回默认英文占位嗓',
    edgeFallback.voice === defaultSynth.voice,
    edgeFallback.voice
  )

  const offlineSynth = resolveVoiceOutSynth('offline', 'eula', VOICE_OUT_TEST_LINE)
  push(
    'offline 引擎按选择出本地嗓，wav',
    offlineSynth.engine === 'offline' &&
      offlineSynth.voice === 'eula' &&
      offlineSynth.audioMime === 'audio/wav',
    JSON.stringify(offlineSynth)
  )
  const offlineFallback = resolveVoiceOutSynth(
    'offline',
    'zh-CN-XiaoxiaoNeural',
    VOICE_OUT_TEST_LINE
  )
  push(
    'offline 引擎音色不在离线清单里 → 打回 baker（清单首位）',
    offlineFallback.voice === OFFLINE_VOICES[0].id,
    offlineFallback.voice
  )

  const sovitsSynth = resolveVoiceOutSynth('sovits', 'whatever', VOICE_OUT_TEST_LINE)
  push(
    'GV 引擎不选嗓（音色由参考音频/音色包权重决定），wav',
    sovitsSynth.engine === 'sovits' &&
      sovitsSynth.voice === '' &&
      sovitsSynth.audioMime === 'audio/wav',
    JSON.stringify(sovitsSynth)
  )

  const zhSynth = resolveVoiceOutSynth('edge', '', '这波打得漂亮，好运！')
  const gvLang = resolveVoiceOutSynth('sovits', '', VOICE_OUT_TEST_LINE)
  push(
    '合成语言看文本本身（与朗读 decideSpeak 同判据），不看设置',
    zhSynth.lang === 'zh' && gvLang.lang === 'en',
    `${zhSynth.lang} / ${gvLang.lang}`
  )

  const gvSynth = resolveVoiceOutSynth('sovits', '', VOICE_OUT_TEST_LINE)
  const gvPlan = decideVoiceOutTest(true, VOICE_OUT_TEST_LINE, gvSynth)
  push(
    '引擎决策整体进「念」计划（GV → 引擎/空嗓/wav 原样携带）',
    gvPlan.speak &&
      gvPlan.engine === 'sovits' &&
      gvPlan.voice === '' &&
      gvPlan.audioMime === 'audio/wav',
    JSON.stringify(gvPlan)
  )
  const offlineSynthPlan = resolveVoiceOutSynth('offline', 'eula', VOICE_OUT_TEST_LINE)
  const offlineSkip = decideVoiceOutTest(false, VOICE_OUT_TEST_LINE, offlineSynthPlan)
  push(
    '合成失败 → 不念：引擎跟设置走，嗓不带出（说键绝不按）',
    !offlineSkip.speak &&
      offlineSkip.engine === 'offline' &&
      offlineSkip.voice === '' &&
      offlineSkip.skip === 'synth-failed',
    JSON.stringify(offlineSkip)
  )

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

  // —— 决策五（票 05）：一键到底该不该声出、走哪条静默分支 ——
  const noSpeech = decideVoiceOutReply({ recognized: '', translated: null })
  push(
    '识别为空 → 不出声，静默分支标 recognize',
    !noSpeech.speak && noSpeech.skip === 'empty-recognition',
    JSON.stringify(noSpeech)
  )
  const blankSpeech = decideVoiceOutReply({ recognized: '   ', translated: null })
  push('识别只剩空白 → 同样静默', !blankSpeech.speak && blankSpeech.skip === 'empty-recognition', JSON.stringify(blankSpeech))
  const noTranslation = decideVoiceOutReply({ recognized: '小心肉山', translated: null })
  push(
    '翻译失败（null）→ 不出声，绝不回退系统嗓子也不退文出',
    !noTranslation.speak && noTranslation.skip === 'translate-failed',
    JSON.stringify(noTranslation)
  )
  const blankTranslation = decideVoiceOutReply({ recognized: '小心肉山', translated: '   ' })
  push(
    '译文只剩空白 → 不出声',
    !blankTranslation.speak && blankTranslation.skip === 'empty-translation',
    JSON.stringify(blankTranslation)
  )
  const replyPlan = decideVoiceOutReply({ recognized: ' 小心肉山 ', translated: ' Careful, they are doing Roshan. ' })
  push(
    '拿到非空译文 → 念 trim 后的译文，默认引擎出英文占位嗓',
    replyPlan.speak && replyPlan.text === 'Careful, they are doing Roshan.' && replyPlan.voice === defaultSynth.voice && replyPlan.skip === null,
    JSON.stringify(replyPlan)
  )
  // 票 07 后声出腿逐段按设置引擎解析（嗓键传空、不挑面板嗓）：封装配引擎，播放才不会拿错封装。
  const replyEdge = resolveVoiceOutSynth('edge', '', replyPlan.text)
  const replyOffline = resolveVoiceOutSynth('offline', '', replyPlan.text)
  const replySovits = resolveVoiceOutSynth('sovits', '', replyPlan.text)
  push(
    '声出腿按设置引擎逐段解析（edge 英文占位 / offline 清单首位 / GV 不选嗓），封装各随引擎',
    replyEdge.voice === defaultSynth.voice &&
      replyOffline.voice === OFFLINE_VOICES[0].id &&
      replySovits.voice === '' &&
      replyEdge.audioMime === 'audio/mpeg' &&
      replyOffline.audioMime === 'audio/wav' &&
      replySovits.audioMime === 'audio/wav',
    JSON.stringify({ edge: replyEdge, offline: replyOffline, sovits: replySovits })
  )

  // —— 决策六（票 05）：段落合成 → 可播列表 ——
  const partial = pickPlayableSegments(['Push mid.', 'They do Roshan.', 'Careful.'], [null, 'B', null])
  push(
    '单段合成失败整段跳过，顺序保持不变',
    partial.length === 1 && partial[0].text === 'They do Roshan.' && partial[0].audio === 'B',
    JSON.stringify(partial)
  )
  push(
    '全部合成失败 → 空列表（整句静默跳过）',
    pickPlayableSegments(['a', 'b'], [null, undefined]).length === 0,
    'all-null→[]'
  )
  push('没有段就没有声', pickPlayableSegments([], []).length === 0, 'empty→[]')
  const ordered = pickPlayableSegments(['x', 'y'], ['Y', 'X'])
  push(
    '音频和文本按同一位次配对（不许错位）',
    ordered.length === 2 && ordered[0].text === 'x' && ordered[0].audio === 'Y' && ordered[1].text === 'y' && ordered[1].audio === 'X',
    JSON.stringify(ordered)
  )

  // —— 决策七（票 05）：已播状态的第三行 ——
  const spokenOk = spokenStatusLine(true, null)
  push('播成功 → 绿字「已播」', spokenOk.ok && spokenOk.text === '已播', JSON.stringify(spokenOk))
  const spokenErr = spokenStatusLine(false, 'Edge 合成失败（断网或接口不可用），这句不出声')
  push(
    '播失败 → 红字带原因',
    !spokenErr.ok && spokenErr.text.startsWith('✕ ') && spokenErr.text.includes('合成失败'),
    JSON.stringify(spokenErr)
  )
  const spokenNoReason = spokenStatusLine(false, null)
  push('没给原因也有兜底话术', !spokenNoReason.ok && spokenNoReason.text === '✕ 声出失败，这句没播', JSON.stringify(spokenNoReason))
  push('空白原因同样走兜底', spokenStatusLine(false, '  ').text === '✕ 声出失败，这句没播', 'blank reason→default')

  // —— 决策八（票 05）：英文译文复用朗读分句（join 等价 + 上限内） ——
  const longReply = 'Push mid now, they are doing Roshan, ward their jungle and group up for the high ground push.'
  const segmented = splitForSpeech(longReply, 30)
  push(
    '英文长句切段：拼回一字不差，每段不超上限',
    segmented.join('') === longReply && segmented.every((segment) => segment.length <= 30),
    `${segmented.length} 段: ${JSON.stringify(segmented)}`
  )
  push('短句单段直出', splitForSpeech('Push mid.', 30).length === 1, 'Push mid.')
  const hardSlice = 'a'.repeat(73)
  const sliced = splitForSpeech(hardSlice, 30)
  push(
    '无标点超长句硬切也不丢字',
    sliced.join('') === hardSlice && sliced.every((segment) => segment.length <= 30),
    `${sliced.length} 段`
  )

  const failed = cases.filter((item) => !item.ok)
  for (const item of cases) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name} ${item.detail}`)
  }
  console.log(
    `VOICE_OUT_PROBE ${JSON.stringify({ ok: failed.length === 0, passed: cases.length - failed.length, failed: failed.length })}`
  )
  app.exit(failed.length > 0 ? 1 : 0)
}
