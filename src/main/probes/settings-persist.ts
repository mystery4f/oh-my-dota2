import { app } from 'electron'
import { copyFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DEFAULT_SETTINGS, type AppSettings } from '@shared/ipc'
import { loadSettings, saveSettings } from '../services/settings'

/** 面板上这些「选过的值」必须活过一次重启；逐个写哨兵值再读回来。 */
const PERSISTED_FIELDS = [
  'autoStartCapture',
  'quickPhrases',
  'replyTone',
  'overlayText',
  'overlayLocked',
  'overlayOpacity',
  'ttsEngine',
  'ttsVoice',
  'ttsPitch',
  'ttsReadOwn',
  'ttsDropBacklog',
  'ttsSpeakSegmentChars',
  'ttsOutputDevice',
  'ttsSpeakKey',
  'ttsSpeakMode',
  'voiceCaptureMode',
  'ttsOutEngine',
  'ttsOutVoice',
  'voiceOutTestMode',
  'voiceTranscribeOnly',
  'asrActiveModel',
  'asrHotwords',
  'asrCorrectionsToDataset',
  'trainKind',
  'trainDataset',
] as const

/** 数组字段不能比引用（loadSettings 每次深合并出新数组）：按 JSON 内容比。 */
function jsonSame(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** 写入值/读回值/磁盘值三方一致；数组键走 jsonSame，其余键严格相等就够。 */
function sameValue(key: string, a: unknown, b: unknown): boolean {
  return key === 'quickPhrases' ? jsonSame(a, b) : a === b
}

/** 每一项都换成一个和当前值不同的哨兵，避免「读回来的是原值」这种假通过。 */
function sentinelFor(
  key: (typeof PERSISTED_FIELDS)[number],
  current: AppSettings
): AppSettings[typeof key] {
  switch (key) {
    case 'autoStartCapture':
      return !current.autoStartCapture as AppSettings[typeof key]
    case 'quickPhrases':
      // 数组也走哨兵：换成一块和当前不同的短语表，验证「数组真的落盘」。
      return (current.quickPhrases.includes('Push mid')
        ? ['Fall back', 'Nice play']
        : ['Push mid', 'Push mid now']) as AppSettings[typeof key]
    case 'replyTone':
      return (current.replyTone === 'firm' ? 'polite' : 'firm') as AppSettings[typeof key]
    case 'overlayText':
      return (current.overlayText === 'translated' ? 'both' : 'translated') as AppSettings[typeof key]
    case 'overlayOpacity':
      return 0.2 as AppSettings[typeof key]
    case 'overlayLocked':
      return !current.overlayLocked as AppSettings[typeof key]
    case 'ttsReadOwn':
      return !current.ttsReadOwn as AppSettings[typeof key]
    case 'ttsDropBacklog':
      return !current.ttsDropBacklog as AppSettings[typeof key]
    case 'ttsSpeakSegmentChars':
      // 20 / 40 都是面板能设的值，验的是「数字真的落盘」。
      return (current.ttsSpeakSegmentChars >= 30 ? 20 : 40) as AppSettings[typeof key]
    case 'ttsEngine':
      return (current.ttsEngine === 'edge' ? 'system' : 'edge') as AppSettings[typeof key]
    case 'ttsVoice':
      // 换一个真实存在的嗓子，验证的是「选中的那一个」而不是「任意字符串」。
      return (current.ttsVoice === 'zh-CN-XiaoyiNeural'
        ? 'zh-CN-XiaoxiaoNeural'
        : 'zh-CN-XiaoyiNeural') as AppSettings[typeof key]
    case 'ttsPitch':
      // 0.9 / 1.1 都是面板滑杆能到的值，验的是「滑杆位置真的落盘」。
      return (current.ttsPitch > 1 ? 0.9 : 1.1) as AppSettings[typeof key]
    case 'ttsOutputDevice':
      // 哨兵值是「一台不存在的设备」：存的是原样字符串还是原样回来（归一化不发生在写入侧）。
      return (current.ttsOutputDevice === 'sink-sentinel-a' ? 'sink-sentinel-b' : 'sink-sentinel-a') as AppSettings[typeof key]
    case 'ttsSpeakKey':
      // 两个都是合法键：验的是「选中的那一个」而不是「任意字符串」。
      return (current.ttsSpeakKey === 'F5' ? 'F6' : 'F5') as AppSettings[typeof key]
    case 'ttsSpeakMode':
      // 两个都是合法模式：验的是「选中的那一个」而不是「任意字符串」（乱填由 settings 归一化打回 hold）。
      return (current.ttsSpeakMode === 'hold' ? 'toggle' : 'hold') as AppSettings[typeof key]
    case 'voiceCaptureMode':
      // 同上：hold / toggle 都是合法值，乱填由 settings 的 normalizeCaptureMode 打回 hold。
      return (current.voiceCaptureMode === 'hold' ? 'toggle' : 'hold') as AppSettings[typeof key]
    case 'ttsOutEngine':
      // 两个都是合法引擎（edge / offline）：合法值必须原样落盘原样读回。
      return (current.ttsOutEngine === 'edge' ? 'offline' : 'edge') as AppSettings[typeof key]
    case 'ttsOutVoice':
      // 声出清单里真实存在的英文嗓，验证「选中的那一个」；音色字段不归一化（决策层打回）。
      return (
        current.ttsOutVoice === 'en-US-JennyNeural' ? 'en-US-AnaNeural' : 'en-US-JennyNeural'
      ) as AppSettings[typeof key]
    case 'voiceOutTestMode':
      // 布尔开关：非当前值落盘原样读回（无归一化，同 ttsReadOwn 一档）。
      return !current.voiceOutTestMode as AppSettings[typeof key]
    case 'voiceTranscribeOnly':
      // 布尔开关：非当前值落盘原样读回（无归一化，同 voiceOutTestMode 一档）。
      return !current.voiceTranscribeOnly as AppSettings[typeof key]
    case 'asrActiveModel':
      // 现役模型 id：字符串原样读回即可，感知不到目录存在的校验不在读入侧做。
      return 'qwen3:asr-models/qwen3-asr.bak' as AppSettings[typeof key]
    case 'asrHotwords':
      // 热词表：带中文逗号与顿号的串原样落盘原样读回（分隔符归一化只在读取热词时做）。
      return (current.asrHotwords.includes('肉山') ? '买活,高地、风暴之灵' : '肉山，买活') as AppSettings[typeof key]
    case 'asrCorrectionsToDataset':
      // 纠错样本回喂开关：布尔，非当前值落盘原样读回（缺省 true，归一化在 loadSettings）。
      return !current.asrCorrectionsToDataset as AppSettings[typeof key]
    case 'trainKind':
      // 训练任务类型：非当前值落盘原样读回（枚举归一化在 loadSettings，探针喂合法值）。
      return (current.trainKind === 'demo' ? 'gv-sovits' : 'demo') as AppSettings[typeof key]
    case 'trainDataset':
      return (current.trainDataset.includes('ftv1') ? 'ftv2-dataset' : 'ftv1-dataset') as AppSettings[typeof key]
  }
}

/** 磁盘原样：带一处已退役的 asrEngine，只为验证它读入即丢、落盘不再出现（#67）。 */
function readFileSettings(): (Partial<AppSettings> & { asrEngine?: unknown }) | null {
  try {
    const file = join(app.getPath('userData'), 'settings.json')
    if (!existsSync(file)) return null
    return JSON.parse(readFileSync(file, 'utf-8')) as Partial<AppSettings>
  } catch {
    return null
  }
}

/**
 * 设置持久化探针（--settings-persist-probe）：纯读写，不抓屏不 OCR。
 *
 * 盯的是用户提的那条要求 ——「默认值可以保守，但用户上次选的那一项，下次启动要记住」。
 * 探针先把整份 settings.json 备份到临时目录，最后原样还原，所以跑多少次都不会污染真实配置。
 */
export async function runSettingsPersistProbe(): Promise<void> {
  const file = join(app.getPath('userData'), 'settings.json')
  const backupDir = mkdtempSync(join(tmpdir(), 'oh-my-dota2-settings-'))
  const backup = join(backupDir, 'settings.json')
  const hadFile = existsSync(file)
  if (hadFile) copyFileSync(file, backup)

  const checks: { name: string; ok: boolean; detail?: string }[] = []
  const push = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, detail })
  }

  try {
    const before = loadSettings()
    // 默认值只在「没有 settings.json」时才决定行为：全新安装读到的必须是 DEFAULT_SETTINGS。
    rmSync(file, { force: true })
    const fresh = loadSettings()
    push(
      '全新安装读到默认值',
      fresh.autoStartCapture === DEFAULT_SETTINGS.autoStartCapture &&
        jsonSame(fresh.quickPhrases, DEFAULT_SETTINGS.quickPhrases),
      `autoStart=${fresh.autoStartCapture}`
    )

    for (const key of PERSISTED_FIELDS) {
      const sentinel = sentinelFor(key, before)
      const written = saveSettings({ [key]: sentinel } as Partial<AppSettings>)
      const reread = loadSettings()
      const onDisk = readFileSettings()
      push(
        `${key} 写盘后可读回`,
        sameValue(key, written[key], sentinel) &&
        sameValue(key, reread[key], sentinel) &&
        sameValue(key, onDisk?.[key], sentinel),
        `${String(before[key])} → ${String(sentinel)} / disk=${String(onDisk?.[key])}`
      )
    }

    // 热键表是嵌套对象，单独验：整表落盘能读回、只改一项不会把别的动作冲掉、
    // 未绑定的空串也能存下来（否则「我不想要这个键」重启后会自动复活）。
    const hotkeySentinel = { ...before.hotkeys, overlayToggle: 'Ctrl+Shift+F9', voiceCapture: '' }
    saveSettings({ hotkeys: hotkeySentinel })
    const hotkeysBack = loadSettings().hotkeys
    push(
      '热键表整表落盘可读回',
      JSON.stringify(hotkeysBack) === JSON.stringify(hotkeySentinel),
      `${JSON.stringify(before.hotkeys)} → ${JSON.stringify(hotkeysBack)}`
    )
    saveSettings({ hotkeys: { ...hotkeysBack, overlayLock: 'Ctrl+F10' } })
    const partialHotkeys = loadSettings().hotkeys
    push(
      '只改一个动作不冲掉别的动作',
      partialHotkeys.overlayLock === 'Ctrl+F10' && partialHotkeys.overlayToggle === 'Ctrl+Shift+F9',
      JSON.stringify(partialHotkeys)
    )
    push(
      '未绑定的空串能存活重启',
      partialHotkeys.voiceCapture === '',
      JSON.stringify(partialHotkeys.voiceCapture)
    )
    // 手编文件塞进非法键/非字符串：逐项回落默认，不能把整张表打成默认或者直接崩。
    const fileNow = readFileSettings() ?? {}
    writeFileSync(
      file,
      JSON.stringify({
        ...fileNow,
        hotkeys: { overlayToggle: 'Ctrl+Shift+F8', overlayLock: 42, overlayCollapse: 'nonsense' }
      }),
      'utf-8'
    )
    const salvaged = loadSettings().hotkeys
    push(
      '坏掉的热键项逐项回落默认',
      salvaged.overlayToggle === 'Ctrl+Shift+F8' &&
        salvaged.overlayLock === DEFAULT_SETTINGS.hotkeys.overlayLock &&
        salvaged.overlayCollapse === DEFAULT_SETTINGS.hotkeys.overlayCollapse &&
        salvaged.inplaceSend === DEFAULT_SETTINGS.hotkeys.inplaceSend,
      JSON.stringify(salvaged)
    )

    // 一个字段的写入不能把别的字段冲掉：写了整轮之后，第一项必须还在。
    const firstKey = PERSISTED_FIELDS[0]
    const afterAll = loadSettings()
    push(
      '连续写入互不覆盖',
      afterAll[firstKey] === sentinelFor(firstKey, before),
      `${firstKey}=${String(afterAll[firstKey])}`
    )

    // 用户的核心诉求：选过的值活过一次重启，而不是每次都回落到默认值。
    // 快捷短语是数组字段：整块替换再读回，确认数组的「选过」也能活过重启。
    saveSettings({ quickPhrases: ['Hello there', 'Ward bottom'] })
    const keptPhrases = loadSettings().quickPhrases
    push('选过的短语表不再回落默认值', keptPhrases[0] === 'Hello there', keptPhrases.join(' | '))

    // 残缺文件不能把整份配置读成 undefined：写一份空 JSON，缺的字段必须回落到默认值。
    writeFileSync(file, '{}', 'utf-8')
    const fromEmpty = loadSettings()
    push(
      '残缺文件按字段回落到默认值',
      fromEmpty.autoStartCapture === DEFAULT_SETTINGS.autoStartCapture &&
        jsonSame(fromEmpty.quickPhrases, DEFAULT_SETTINGS.quickPhrases),
      `autoStart=${fromEmpty.autoStartCapture}`
    )

    // 未登记的键不该让读取炸掉（老版本文件多出来的字段）。
    writeFileSync(file, JSON.stringify({ quickPhrases: ['sentinel-phrase'], retiredKey: { nested: 1 } }), 'utf-8')
    const withUnknown = loadSettings()
    push('未知字段被忽略', withUnknown.quickPhrases[0] === 'sentinel-phrase', withUnknown.quickPhrases.join(' | '))

    // 退役字段 asrEngine（#67）：老 settings.json 里还躺着它（whisper / qwen3 / sensevoice），
    // 读入必须原样能开、字段被丢掉，再落盘也不能把它写回去——否则死字段会永远活着。
    writeFileSync(
      file,
      JSON.stringify({
        asrEngine: 'whisper',
        asrActiveModel: 'paraformer:asr-models/paraformer-zh',
        quickPhrases: ['legacy-engine']
      }),
      'utf-8'
    )
    const legacyEngine = loadSettings() as AppSettings & { asrEngine?: unknown }
    push(
      '退役字段 asrEngine 读入即丢弃',
      !('asrEngine' in legacyEngine) &&
        legacyEngine.asrActiveModel === 'paraformer:asr-models/paraformer-zh' &&
        legacyEngine.quickPhrases[0] === 'legacy-engine',
      `asrEngine=${String(legacyEngine.asrEngine)} active=${legacyEngine.asrActiveModel}`
    )
    saveSettings({ quickPhrases: ['legacy-engine', 'after-save'] })
    const legacyOnDisk = readFileSettings()
    push(
      '退役字段 asrEngine 不再被写回',
      legacyOnDisk !== null && !('asrEngine' in legacyOnDisk) && legacyOnDisk.asrActiveModel === 'paraformer:asr-models/paraformer-zh',
      `asrEngine=${String(legacyOnDisk?.asrEngine)}`
    )

    // —— #42 漂移仲裁：key 表的三条裁决都走真实 loadSettings 路径（手写文件再读）。
    // 写的文件不带这些字段，'结束后原样还原' 那条在全新安装场景也能按默认值对上。
    // ① 手编文件改了活 key、表里躺着旧 key：活值赢，表被更新（否则切走再切回会复活旧 key）。
    writeFileSync(
      file,
      JSON.stringify({
        provider: { ...DEFAULT_SETTINGS.provider, apiKey: 'hand-edited-live-key' },
        providerKeys: { deepseek: 'stale-archived-key', zhipu: 'zhipu-kept' }
      }),
      'utf-8'
    )
    const adopted = loadSettings()
    push(
      '手编活 key 覆盖表里的旧 key',
      adopted.providerKeys?.deepseek === 'hand-edited-live-key' &&
        adopted.provider.apiKey === 'hand-edited-live-key',
      JSON.stringify(adopted.providerKeys)
    )
    push('漂移仲裁不碰别家的表项', adopted.providerKeys?.zhipu === 'zhipu-kept', adopted.providerKeys?.zhipu ?? 'undefined')
    // ② 活 key 空、表里有值：空值不许顶掉已记住的 key。
    writeFileSync(
      file,
      JSON.stringify({
        provider: { ...DEFAULT_SETTINGS.provider, apiKey: '' },
        providerKeys: { deepseek: 'archived-kept-key' }
      }),
      'utf-8'
    )
    const kept = loadSettings()
    push('空活 key 不顶掉表里的值', kept.providerKeys?.deepseek === 'archived-kept-key', kept.providerKeys?.deepseek ?? 'undefined')
    // ③ 旧存档只有活 key、没有表：仍按 id 播种（迁移是仲裁规则的特例）。
    writeFileSync(
      file,
      JSON.stringify({ provider: { ...DEFAULT_SETTINGS.provider, apiKey: 'legacy-live-key' } }),
      'utf-8'
    )
    const seeded = loadSettings()
    push('旧存档仍按 id 播种表', seeded.providerKeys?.deepseek === 'legacy-live-key', seeded.providerKeys?.deepseek ?? 'undefined')

    // —— #43 推理存档：形状与 key 表同款，走真实 loadSettings/saveSettings 路径。
    // ① 轮换两家各自的开关：MiMo 开、智谱关，落盘读回各自都在（切家不丢各自的档）。
    saveSettings({
      provider: {
        ...DEFAULT_SETTINGS.provider,
        id: 'mimo',
        baseUrl: 'https://api.xiaomimimo.com/v1',
        model: 'mimo-v2.6-flash',
        reasoning: true
      },
      providerReasoning: { mimo: true, zhipu: false }
    })
    const roundtrip = loadSettings()
    push(
      '推理存档落盘可读回（含别家的档）',
      roundtrip.providerReasoning?.mimo === true &&
        roundtrip.providerReasoning?.zhipu === false &&
        roundtrip.provider.reasoning === true,
      JSON.stringify(roundtrip.providerReasoning)
    )
    // ② 深合并不冲掉：只 patch 一家的开关，别家保持原样。
    saveSettings({ providerReasoning: { custom: true } })
    const mergedReasoning = loadSettings()
    push(
      '只写一家的推理开关不冲掉别家',
      mergedReasoning.providerReasoning?.mimo === true &&
        mergedReasoning.providerReasoning?.zhipu === false &&
        mergedReasoning.providerReasoning?.custom === true,
      JSON.stringify(mergedReasoning.providerReasoning)
    )
    // ③ 同一份手编文件：key 走漂移仲裁、推理走归位（deepseek 预设未声明 → 用户值保留），两条规则互不干扰。
    writeFileSync(
      file,
      JSON.stringify({
        provider: { ...DEFAULT_SETTINGS.provider, apiKey: 'hand-live-key', reasoning: true },
        providerKeys: { deepseek: 'stale-key' },
        providerReasoning: { deepseek: true, zhipu: false }
      }),
      'utf-8'
    )
    const both = loadSettings()
    push(
      '同一份文件：key 仲裁与推理归位互不干扰',
      both.providerKeys?.deepseek === 'hand-live-key' &&
        both.provider.reasoning === true &&
        both.providerReasoning?.deepseek === true &&
        both.providerReasoning?.zhipu === false,
      JSON.stringify({ keys: both.providerKeys, reasoning: both.providerReasoning, live: both.provider.reasoning })
    )
    // ④ 存档表坏掉（非对象）：静默兜底成空表，不炸，key 仲裁照常工作。
    writeFileSync(
      file,
      JSON.stringify({
        provider: { ...DEFAULT_SETTINGS.provider, apiKey: 'keep-key' },
        providerReasoning: 'garbage'
      }),
      'utf-8'
    )
    const salvagedReasoning = loadSettings()
    push(
      '坏掉的推理存档兜底成空表且不影响 key 仲裁',
      salvagedReasoning.providerReasoning !== undefined &&
        Object.keys(salvagedReasoning.providerReasoning).length === 0 &&
        salvagedReasoning.providerKeys?.deepseek === 'keep-key',
      JSON.stringify(salvagedReasoning.providerReasoning)
    )
    // ⑤ 词数上限：哨兵往返、坏值钳回、越界钳边。
    saveSettings({ translationMaxWords: 24 })
    const maxRoundtrip = loadSettings()
    push('词数上限落盘可读回', maxRoundtrip.translationMaxWords === 24, String(maxRoundtrip.translationMaxWords))
    saveSettings({ translationMaxWords: 'garbage' as unknown as number })
    const maxGarbage = loadSettings()
    push('词数上限坏值回默认 16', maxGarbage.translationMaxWords === 16, String(maxGarbage.translationMaxWords))
    saveSettings({ translationMaxWords: 99 })
    const maxHigh = loadSettings()
    push('词数上限越界钳到 32', maxHigh.translationMaxWords === 32, String(maxHigh.translationMaxWords))
    saveSettings({ translationMaxWords: 0 })
    const maxLow = loadSettings()
    push('词数上限下界钳到 4', maxLow.translationMaxWords === 4, String(maxLow.translationMaxWords))
  } finally {
    if (hadFile) copyFileSync(backup, file)
    rmSync(backupDir, { recursive: true, force: true })
    const restored = loadSettings()
    const expected = hadFile ? readFileSettings() : null
    checks.push({
      name: '结束后原样还原',
      ok: hadFile
        ? restored.autoStartCapture === expected?.autoStartCapture
        : restored.autoStartCapture === DEFAULT_SETTINGS.autoStartCapture,
      detail: `autoStart=${restored.autoStartCapture}`
    })
  }

  const failed = checks.filter((item) => !item.ok)
  console.log(
    'SETTINGS_PERSIST_PROBE',
    JSON.stringify({ ok: failed.length === 0, passed: checks.length - failed.length, failed: failed.length })
  )
  for (const item of checks) {
    console.log(`  ${item.ok ? 'ok  ' : 'FAIL'} ${item.name}${item.detail ? `  (${item.detail})` : ''}`)
  }
  app.exit(failed.length === 0 ? 0 : 1)
}
