import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS, OFFLINE_VOICES, type AppSettings, type ProviderConfig } from '@shared/ipc'
import { normalizeTrainKind } from '@shared/train/task'
import { normalizeSpeakKey, normalizeSpeakMode, normalizeVoiceOutEngine } from '@shared/voice-out'
import { normalizeCaptureMode, normalizeHotkeyMap } from '@shared/hotkeys'
import { healProvider } from '@shared/providers'
import { maxWordsFromSettings } from './providers'

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): AppSettings {
  try {
    const file = settingsFile()
    if (!existsSync(file)) return structuredClone(DEFAULT_SETTINGS)
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<AppSettings>
    return normalizeSettings(mergeSettings(structuredClone(DEFAULT_SETTINGS), parsed), parsed)
  } catch (err) {
    console.error('settings: load failed, using defaults', err)
    return structuredClone(DEFAULT_SETTINGS)
  }
}

/**
 * 存档里的「表」只认普通对象：字符串/数组/数字展开时会把下标当成 id（`"garbage"` → 7 个假家），
 * 坏值一律当没写，让基座的值原样留下——设置文件是用户数据，坏一处不该炸整个面板。
 */
function tablePatch<T extends object>(value: unknown): Partial<T> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return {}
  return value as Partial<T>
}

/** 缺省值 + 存档的合并：读写两条路共用，避免「读时兜底、写时不兜底」的双份定义。 */
/** 当前值 + 增量的合并：读盘（基座=缺省值）与写盘（基座=现值）两条路共用，避免「读时兜底、写时不兜底」的双份定义。 */
function mergeSettings(base: AppSettings, patch: Partial<AppSettings>): AppSettings {
  return {
    ...base,
    ...patch,
    provider: { ...base.provider, ...(patch.provider ?? {}) } as ProviderConfig,
    // key 表与推理开关表按 id 深合并（#43）：增量只提一个家时，没提到的 id 保持原样。
    // 两张表都只认对象：手编文件里躺个字符串时，展开会把每个字符当成 provider id
    // （`providerReasoning: "garbage"` → `{0:'g',1:'a',…}`），面板与仲裁都会看到一堆假家。
    providerKeys: { ...base.providerKeys, ...tablePatch(patch.providerKeys) },
    providerReasoning: { ...base.providerReasoning, ...tablePatch(patch.providerReasoning) },
    // 热键表要按动作深合并：浅合并会让「只改一个键」的存档把另外四个动作抹成 undefined。
    // 具体哪一项该回落默认交给 normalizeHotkeyMap 逐项兜底（未知 id 丢掉、非法值回默认）。
    hotkeys: normalizeHotkeyMap({ ...base.hotkeys, ...(patch.hotkeys ?? {}) })
  }
}

/** 归一化的唯一入口：读盘（loadSettings）与写盘（saveSettings）都从这里走一遍。 */
export function normalizeSettings(merged: AppSettings, raw: Partial<AppSettings> = {}): AppSettings {
    // 供应商三件套的漂移仲裁（authStyle / key 表 / 推理表）在 @shared/providers 的 healProvider。
    healProvider(merged)
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
    // 说话方式：hold = 按住整段，toggle = 敲一下开麦、播完再敲一下关麦。乱填打回 hold——
    // 坏值落到 toggle 的后果是「开麦不关」，队友会全程听到房间回声。
    merged.ttsSpeakMode = normalizeSpeakMode(merged.ttsSpeakMode)
    // 语音对讲怎么按：hold 按住说话、松开触发；toggle 按一下开录、再按一下触发。乱填打回 hold。
    merged.voiceCaptureMode = normalizeCaptureMode(merged.voiceCaptureMode)
    // 声出引擎：只认三引擎层的合法值，乱填打回 edge（英文占位）；声出音色不在这里钳，
    // resolveVoiceOutSynth 决策时对不上清单自会打回默认（和 ttsVoice 同一策略）。
    merged.ttsOutEngine = normalizeVoiceOutEngine(merged.ttsOutEngine)
    // 退役字段 asrEngine（#67）：引擎由 asrActiveModel 指向的模型所属引擎决定，这个字段已无读者。
    // 老 settings.json 里还躺着它（whisper / qwen3 / sensevoice）：读入时直接删掉，不迁移也不写回，
    // 否则下一次落盘会把死字段再写回去，用户以为改了引擎其实没人读。
    delete (merged as AppSettings & { asrEngine?: unknown }).asrEngine
    // 现役识别模型 id：只认字符串，空 = 按可用性自动选（注册表回落）。
    // 不在读入时校验 id 是否还存在——模型目录是运行时可变的，校验放 asr-model 的钉选入口。
    if (typeof merged.asrActiveModel !== 'string') merged.asrActiveModel = ''
    // 热词表：只存字符串，格式约束交给 @shared/asr-hotwords 的解析（分分隔符/去重）。
    if (typeof merged.asrHotwords !== 'string') merged.asrHotwords = DEFAULT_SETTINGS.asrHotwords
    // 纠错样本回喂：只认布尔；缺省/乱填都按默认开（关掉是显式动作，缺省不该悄悄少存数据）。
    if (typeof merged.asrCorrectionsToDataset !== 'boolean') {
      merged.asrCorrectionsToDataset = DEFAULT_SETTINGS.asrCorrectionsToDataset
    }
    // 短句/长句分流（#122）：只认布尔，缺省/乱填都按关（多一副模型在场才谈得上分流）。
    if (typeof merged.asrRouteShortLong !== 'boolean') {
      merged.asrRouteShortLong = DEFAULT_SETTINGS.asrRouteShortLong
    }
    // 训练窗口记忆：kind 乱值打回 demo，dataset 只认字符串。
    merged.trainKind = normalizeTrainKind(merged.trainKind)
    if (typeof merged.trainDataset !== 'string') merged.trainDataset = DEFAULT_SETTINGS.trainDataset
    // 微调环境根目录：只认字符串，空串 = 用应用数据目录的 asr-ft-env。
    if (typeof merged.asrFtEnvDir !== 'string') merged.asrFtEnvDir = DEFAULT_SETTINGS.asrFtEnvDir
    // 词表包名（#82）：只认字符串，空串 = 内置表。名字要能被拼成文件名，所以去掉路径与空白，
    // 长过 GLOSSARY_PACK_NAME_MAX 的名直接打回内置（装不上比装一个奇怪名字安全）。
    if (typeof merged.glossaryPackName !== 'string') merged.glossaryPackName = ''
    else merged.glossaryPackName = merged.glossaryPackName.trim().replace(/[/\\:*?"<>|]/g, '')
    // 同声传译（#128）：开关只认布尔，设备只认字符串——空串 = 跟声出输出设备。
    if (typeof merged.interpretMode !== 'boolean') merged.interpretMode = DEFAULT_SETTINGS.interpretMode
    if (typeof merged.interpretInDevice !== 'string') merged.interpretInDevice = ''
  if (typeof merged.clauseStreamVoice !== 'boolean') merged.clauseStreamVoice = DEFAULT_SETTINGS.clauseStreamVoice
  return merged
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const current = loadSettings()
  const merged = mergeSettings(current, patch)
  // 落盘前走同一条归一化：面板提交的 999 不能原样进文件（重启才变回 60 就是这条缺失的症状）。
  const next = normalizeSettings(merged, patch)
  const file = settingsFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(next, null, 2), 'utf-8')
  for (const listener of savedListeners) listener(next)
  return next
}

/** 保存后的观察者缝：设置属主发事件，联动（如声出就绪重算）挂在这里，不散在 handler 表。 */
const savedListeners: ((next: AppSettings) => void)[] = []
export function onSettingsSaved(listener: (next: AppSettings) => void): void {
  savedListeners.push(listener)
}
