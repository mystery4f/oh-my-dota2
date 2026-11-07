import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS, OFFLINE_VOICES, PROVIDER_PRESETS, type AppSettings, type ProviderConfig } from '@shared/ipc'
import { normalizeTrainKind } from '@shared/train/task'
import { normalizeSpeakKey, normalizeVoiceOutEngine } from '@shared/voice-out'
import { normalizeHotkeyMap } from '@shared/hotkeys'
import { healProviderReasoning } from '@shared/provider-reasoning'
import { maxWordsFromSettings } from './providers'

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): AppSettings {
  try {
    const file = settingsFile()
    if (!existsSync(file)) return structuredClone(DEFAULT_SETTINGS)
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<AppSettings>
    return normalizeSettings(mergeSettings(parsed), parsed)
  } catch (err) {
    console.error('settings: load failed, using defaults', err)
    return structuredClone(DEFAULT_SETTINGS)
  }
}

/** 缺省值 + 存档的合并：读写两条路共用，避免「读时兜底、写时不兜底」的双份定义。 */
function mergeSettings(parsed: Partial<AppSettings>): AppSettings {
  return {
    ...structuredClone(DEFAULT_SETTINGS),
    ...parsed,
    provider: { ...DEFAULT_SETTINGS.provider, ...(parsed.provider ?? {}) } as ProviderConfig,
    // 热键表要按动作深合并：浅合并会让「只改一个键」的存档把另外四个动作抹成 undefined。
    // 具体哪一项该回落默认交给 normalizeHotkeyMap 逐项兜底（未知 id 丢掉、非法值回默认）。
    hotkeys: normalizeHotkeyMap({ ...DEFAULT_SETTINGS.hotkeys, ...(parsed.hotkeys ?? {}) })
  }
}

/** 归一化的唯一入口：读盘（loadSettings）与写盘（saveSettings）都从这里走一遍。 */
export function normalizeSettings(merged: AppSettings, raw: Partial<AppSettings> = {}): AppSettings {
    // 换预设会残留上一家的 authStyle（MiMo 的 api-key 头风格）：GLM 收不到 Authorization 报 401。
    // 面板从不单独编辑 authStyle，一律以预设声明的为准，存档里的野值在这里归位。
    const preset = PROVIDER_PRESETS.find((item) => item.id === merged.provider.id)
    if (preset && merged.provider.authStyle !== preset.authStyle) merged.provider.authStyle = preset.authStyle
    // 漂移仲裁（#42）：活值非空时永远写回表里——用户手编了 settings.json 的 key，要以手编的为准，
    // 否则切走再切回来，表里那把旧 key 会复活。空串/缺失则不碰表——空值不许顶掉已记住的 key。
    // 旧的「仅缺项时播种」迁移（无条目 + 非空活值）是这条规则的特例，自然归入其中。
    if (!merged.providerKeys || typeof merged.providerKeys !== 'object') merged.providerKeys = {}
    if (merged.provider.apiKey) merged.providerKeys[merged.provider.id] = merged.provider.apiKey
    // 推理存档（#43）：形状与 key 表相同，同样先兜底。预设表声明了 reasoning 的家以声明为准
    // （authStyle 同款归位，活值与存档一起归位）；没声明的预设与 custom 保留用户值，开关仍可各家各编辑。
    if (!merged.providerReasoning || typeof merged.providerReasoning !== 'object') merged.providerReasoning = {}
    const healedReasoning = healProviderReasoning(
      merged.provider.id,
      merged.provider.reasoning,
      preset,
      merged.providerReasoning
    )
    merged.provider.reasoning = healedReasoning.reasoning
    merged.providerReasoning = healedReasoning.providerReasoning
    // 词数上限：坏值（字符串/NaN/越界）钳回 4-32，和提示词、回复截断共用同一条归一化路径。
    merged.translationMaxWords = maxWordsFromSettings(merged.translationMaxWords)
    // 本地音色换过几轮（keqing → melo → baker）：旧值留在文件里会把面板下拉打空。
    // 这里只认还在售的 id，认不出就归位到默认，不抛错——设置文件是用户数据，不该因为改版而炸。
    if (!OFFLINE_VOICES.some((voice) => voice.id === merged.ttsOfflineVoice)) {
      merged.ttsOfflineVoice = DEFAULT_SETTINGS.ttsOfflineVoice
    }
    // 「某某说」前缀换过类型（boolean → 'front'|'back'|'off'）：旧文件里躺着 true/false
    // 也要能读，归一化成新值，别让一次改版把朗读位置打回默认。
    const rawPrefix = (raw as Record<string, unknown>).ttsSpeakPrefix
    if (rawPrefix === true) merged.ttsSpeakPrefix = 'front'
    else if (rawPrefix === false) merged.ttsSpeakPrefix = 'off'
    else if (merged.ttsSpeakPrefix !== 'front' && merged.ttsSpeakPrefix !== 'back' && merged.ttsSpeakPrefix !== 'off') {
      merged.ttsSpeakPrefix = DEFAULT_SETTINGS.ttsSpeakPrefix
    }
    // 说话人模板：不是字符串、或没写 {body}（内容丢了等于没配），一律回缺省。
    const tplFront = (raw as Record<string, unknown>).ttsSpeakFrontTpl
    if (typeof tplFront !== 'string' || !tplFront.includes('{body}')) {
      merged.ttsSpeakFrontTpl = DEFAULT_SETTINGS.ttsSpeakFrontTpl
    }
    const tplBack = (raw as Record<string, unknown>).ttsSpeakBackTpl
    if (typeof tplBack !== 'string' || !tplBack.includes('{body}')) {
      merged.ttsSpeakBackTpl = DEFAULT_SETTINGS.ttsSpeakBackTpl
    }
    // 段长上限：手编文件里躺个 0 / 负数 / 超大值会把切段打瘫（0 等于每字一段），钳回面板能到的范围。
    const rawSeg = Number(merged.ttsSpeakSegmentChars)
    if (!Number.isFinite(rawSeg)) merged.ttsSpeakSegmentChars = DEFAULT_SETTINGS.ttsSpeakSegmentChars
    else merged.ttsSpeakSegmentChars = Math.min(60, Math.max(10, Math.round(rawSeg)))
    // 说话键：只认 F1–F12 和单个字母/数字（SendInput 的 VK 码能对上的集合），乱填打回 F5。
    merged.ttsSpeakKey = normalizeSpeakKey(merged.ttsSpeakKey)
    // 声出引擎：只认三引擎层的合法值，乱填打回 edge（英文占位）；声出音色不在这里钳，
    // resolveVoiceOutSynth 决策时对不上清单自会打回默认（和 ttsVoice 同一策略）。
    merged.ttsOutEngine = normalizeVoiceOutEngine(merged.ttsOutEngine)
    // 识别引擎：只认 qwen3；whisper / sensevoice 都是已退役值，读入时统一迁成 qwen3
    // （#45：whisper.cpp 的下载/探测链路已删，引擎不再分流）。乱填打回默认。
    const rawEngine = merged.asrEngine as string
    if (rawEngine !== 'qwen3') {
      merged.asrEngine = DEFAULT_SETTINGS.asrEngine
    }
    // 热词表：只存字符串，格式约束交给 @shared/asr-hotwords 的解析（分分隔符/去重）。
    if (typeof merged.asrHotwords !== 'string') merged.asrHotwords = DEFAULT_SETTINGS.asrHotwords
    // 训练窗口记忆：kind 乱值打回 demo，dataset 只认字符串。
    merged.trainKind = normalizeTrainKind(merged.trainKind)
    if (typeof merged.trainDataset !== 'string') merged.trainDataset = DEFAULT_SETTINGS.trainDataset
    // 微调环境根目录：只认字符串，空串 = 用应用数据目录的 asr-ft-env。
    if (typeof merged.asrFtEnvDir !== 'string') merged.asrFtEnvDir = DEFAULT_SETTINGS.asrFtEnvDir
  return merged
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const current = loadSettings()
  const merged: AppSettings = {
    ...current,
    ...patch,
    provider: { ...current.provider, ...(patch.provider ?? {}) } as ProviderConfig,
    // key 表按 id 深合并：别的调用方可能只改 provider 不碰 key 表，没提到的 id 保持原样。
    providerKeys: { ...current.providerKeys, ...(patch.providerKeys ?? {}) },
    // 推理开关表同样按 id 深合并（#43）：别的调用方可能只 patch 别的字段，没提到的家保持原样。
    providerReasoning: { ...current.providerReasoning, ...(patch.providerReasoning ?? {}) },
    // 面板一次提交整张热键表，但别的调用方可能只 patch 一个动作：按动作合并，没提到的保持原样。
    hotkeys: normalizeHotkeyMap({ ...current.hotkeys, ...(patch.hotkeys ?? {}) })
  }
  // 落盘前走同一条归一化：面板提交的 999 不能原样进文件（重启才变回 60 就是这条缺失的症状）。
  const next = normalizeSettings(merged, patch)
  const file = settingsFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(next, null, 2), 'utf-8')
  return next
}
