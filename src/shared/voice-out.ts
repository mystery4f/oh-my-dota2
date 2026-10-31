import { OFFLINE_VOICES } from './ipc'
import type { VoiceOutEngine } from './ipc'
import type { TtsVoiceOption } from './tts-voices'

// 引擎类型与 AppSettings 同源（ipc.ts 定义），这里再出口，声出决策面只认 @shared/voice-out。
export type { VoiceOutEngine }

/**
 * 声出（voice-out）的纯决策：念不念、念什么、哪个嗓、输出设备怎么路由、说话键按多久。
 *
 * 主进程只负责执行（合成、播放、SendInput），判断本身全部收在这里，
 * `--voice-out-probe` 才能在零网络、零驱动的情况下把整条链路的「脑子」验一遍。
 * 术语按 GLOSSARY：声出 = 译文合成英文人声经虚拟声卡送进游戏语音；说话键 = 游戏内按住才发言的键。
 */

/** 浮层/面板上的输出回退提示；声出失败时也复用「一行提示」这条路。 */
export const SINK_FALLBACK_HINT = '找不到已选的输出设备，已回退系统默认输出'

/** Chromium 给「系统默认输出」留的固定设备 id（setSinkId 认它）。 */
export const DEFAULT_SINK_ID = 'default'

/**
 * 声出专用的 Edge 英文嗓：**故意不进 EDGE_VOICES**——英文嗓读中文回空音频，
 * 朗读下拉里绝不能出现它们（见 tts-voices.ts 的注释）；只有声出念英文，才用得上。
 * 免费端点的音色集比文档小，加新嗓子前必须先实测能出声再进来。
 */
export const VOICE_OUT_VOICES: TtsVoiceOption[] = [
  { id: 'en-US-JennyNeural', label: 'Jenny · 英文女' },
  { id: 'en-US-AnaNeural', label: 'Ana · 英文童声' }
]

/** 声出默认嗓。GV 英文音色包训练好之前，先用这把神经嗓占位。 */
export const DEFAULT_VOICE_OUT_VOICE = 'en-US-JennyNeural'

/**
 * 声出引擎（VoiceOutEngine 定义在 ipc.ts，与 AppSettings 同源）：并入现有三引擎层
 * （朗读侧的 system 不参与——系统嗓子合成不出能送进频道的音频）。
 * - edge：英文神经嗓占位（默认）；
 * - offline：本地离线模型（中文嗓，念英文吞字，仅链路验证）；
 * - sovits：GV（GPT-SoVITS）音色包——音色由参考音频/权重决定，权重切换走现有音色包管线。
 */
/** 声出默认引擎：GV 英文包训练好之前，先用 Edge 英文神经嗓占位。 */
export const DEFAULT_VOICE_OUT_ENGINE: VoiceOutEngine = 'edge'

/** 手编 JSON / 老配置文件里的垃圾值一律打回默认 edge。 */
export function normalizeVoiceOutEngine(raw: unknown): VoiceOutEngine {
  return raw === 'offline' || raw === 'sovits' ? raw : 'edge'
}

/** 「测试声出」按钮念的固定英文句：要求是纯 ASCII 短句，合成端不挑逗号重音。 */
export const VOICE_OUT_TEST_LINE = 'Hello team, this is a voice out test. Good luck, have fun.'

/** 说话键默认值：与 Dota 2 常见的语音按键习惯一致，面板可改。 */
export const DEFAULT_SPEAK_KEY = 'F5'

/** 按键窗口的头尾余量：提前按下、延后松开，保证游戏收到的语音不吃掉首尾。 */
export const PTT_MARGIN_MS = 200

/** 音频时长拿不到（或为 0）时，至少把频道开这么一小会儿，别按了个寂寞。 */
export const MIN_SPEAK_MS = 150

/** 声出测试的执行决策：念不念（合成成功才有）、念什么（固定英文句）、哪个引擎/哪个嗓。 */
export interface VoiceOutPlan {
  /** false = 这一句不出声，说话键也绝不按（频道里不能开一段空气）。 */
  speak: boolean
  text: string
  /** 引擎跟设置走（skip 时也带着，日志/提示用）；念不念才是这里真正决策的事。 */
  engine: VoiceOutEngine
  /** edge = 声出清单里的英文嗓 id；offline = 离线清单里的本地嗓 id；sovits / skip 时为空串。 */
  voice: string
  /** edge 出 mp3，offline / sovits 出 wav——渲染层按它解 Blob。 */
  audioMime: 'audio/mpeg' | 'audio/wav'
  /** 不念的原因；speak = true 时为 null。 */
  skip: 'synth-failed' | 'empty-line' | null
}

/**
 * 合成前的引擎/音色/格式决策：给设置里的引擎与音色 + 要念的文本，
 * 回「用哪个引擎、哪个嗓、出什么格式、念什么语言」。音色不在对应清单里
 * 一律打回该引擎默认；GV 不选嗓（音色由参考音频决定）。语言看文本本身，
 * 与朗读 decideSpeak 同判据（含 CJK 即中文）。
 */
export interface VoiceOutSynthPlan {
  engine: VoiceOutEngine
  voice: string
  audioMime: 'audio/mpeg' | 'audio/wav'
  lang: 'zh' | 'en'
}

export function resolveVoiceOutSynth(
  engineRaw: unknown,
  voiceRaw: unknown,
  text: string
): VoiceOutSynthPlan {
  const engine = normalizeVoiceOutEngine(engineRaw)
  const lang: 'zh' | 'en' = /[\u3400-\u9fff]/.test(text) ? 'zh' : 'en'
  if (engine === 'sovits') return { engine, voice: '', audioMime: 'audio/wav', lang }
  if (engine === 'offline') {
    const voice = OFFLINE_VOICES.some((item) => item.id === voiceRaw)
      ? (voiceRaw as string)
      : OFFLINE_VOICES[0].id
    return { engine, voice, audioMime: 'audio/wav', lang }
  }
  const voice = VOICE_OUT_VOICES.some((item) => item.id === voiceRaw)
    ? (voiceRaw as string)
    : DEFAULT_VOICE_OUT_VOICE
  return { engine, voice, audioMime: 'audio/mpeg', lang }
}

/**
 * 「测试声出」按钮的决策入口。合成结果（Buffer 或 null）先落地，再决定念不念——
 * 断网 / 引擎失败在这里被拦下：静默跳过，说话键不动。
 * 引擎决策（第 3 参）由 resolveVoiceOutSynth 给出，不传时就是默认 edge 占位。
 */
export function decideVoiceOutTest(
  synthOk: boolean,
  line = VOICE_OUT_TEST_LINE,
  synth = resolveVoiceOutSynth(DEFAULT_VOICE_OUT_ENGINE, '', line)
): VoiceOutPlan {
  const body = line.trim()
  const silenced = {
    speak: false,
    text: '',
    engine: synth.engine,
    voice: '',
    audioMime: synth.audioMime
  } as const
  if (!synthOk) return { ...silenced, skip: 'synth-failed' }
  if (!body) return { ...silenced, skip: 'empty-line' }
  return {
    speak: true,
    text: body,
    engine: synth.engine,
    voice: synth.voice,
    audioMime: synth.audioMime,
    skip: null
  }
}

/** 面板/探针用的最小设备形状：渲染层 enumerateDevices() 过滤 audiooutput 后映射过来。 */
export interface AudioOutputDevice {
  deviceId: string
  label: string
}

/** 输出设备路由的结论：sinkId 喂给 setSinkId，fallback + hint 决定要不要提示。 */
export interface SinkChoice {
  sinkId: string
  /** 命中的设备名（找不到 / 未选择时为空串）。 */
  label: string
  /** 选中的设备不在当前设备列表里 → 回退默认输出，要让用户知道。 */
  fallback: boolean
  /** fallback 时的提示文案；其余为 null。 */
  hint: string | null
}

/**
 * 输出设备路由（纯函数）：先按 deviceId 精确命中（面板下拉存的值），
 * 再按 label 兜底（老配置里躺着的是手填的设备名，如 "CABLE Input (VB-Audio Virtual Cable)"）；
 * 都不中 → 系统默认输出 + 提示，绝不因为设备没插而让整条声出哑掉。
 */
export function resolveOutputSink(requested: string, devices: AudioOutputDevice[]): SinkChoice {
  const wanted = requested.trim()
  if (!wanted) return { sinkId: DEFAULT_SINK_ID, label: '', fallback: false, hint: null }
  const byId = devices.find((device) => device.deviceId === wanted)
  if (byId) return { sinkId: byId.deviceId, label: byId.label, fallback: false, hint: null }
  const byLabel = devices.find((device) => device.label === wanted)
  if (byLabel) return { sinkId: byLabel.deviceId, label: byLabel.label, fallback: false, hint: null }
  return { sinkId: DEFAULT_SINK_ID, label: '', fallback: true, hint: SINK_FALLBACK_HINT }
}

/** 说话键的按住窗口：提前 PTT_MARGIN_MS 按下，音频结束后再过 PTT_MARGIN_MS 松开。 */
export interface PttWindow {
  /** 播放开始前多久按下（毫秒）。 */
  leadMs: number
  /** 播放结束后多久松开（毫秒）。 */
  releaseMs: number
  /** 从按下到松开的总时长（毫秒）＝ 音频 + 头尾余量。 */
  holdMs: number
}

/**
 * 按键时序（纯函数）：按住窗口 = 音频时长 + 头尾各 200ms 余量。
 * 时长拿不到就按 MIN_SPEAK_MS 兜底——频道至少要开一小会儿，绝不会按 0 毫秒。
 */
export function pttWindow(audioMs: number, marginMs = PTT_MARGIN_MS): PttWindow {
  const safe = Number.isFinite(audioMs) && audioMs > 0 ? audioMs : MIN_SPEAK_MS
  const margin = Number.isFinite(marginMs) && marginMs >= 0 ? marginMs : PTT_MARGIN_MS
  return { leadMs: margin, releaseMs: margin, holdMs: safe + margin * 2 }
}

/**
 * 松键保险：ENDED 事件没回来（窗口崩了、解码失败）也不能把说话键按死——
 * 否则用户的语音频道一直开着，队友全程听房间回声。给 hold 窗口翻倍再加 4 秒，最少 5 秒。
 */
export function pttWatchdogMs(window: PttWindow): number {
  return Math.max(5000, window.holdMs * 2 + 4000)
}

/**
 * 说话键归一化：只认 F1–F12 和单个字母/数字（与 SendInput 的 VK 码能对上的集合）。
 * 空串 / 乱填（"ctrl"、"FF"、"F13"）一律打回默认 F5——半失效的键比默认键更难排查。
 */
export function normalizeSpeakKey(raw: string): string {
  const key = (typeof raw === 'string' ? raw : '').trim().toUpperCase()
  if (/^F(?:[1-9]|1[0-2])$/.test(key)) return key
  if (/^[A-Z0-9]$/.test(key)) return key
  return DEFAULT_SPEAK_KEY
}

/** 说话键 → Windows 虚拟键码（喂给 SendInput）。归一化后的值永远解析得出来。 */
export function speakKeyVk(key: string): number | null {
  const normalized = normalizeSpeakKey(key)
  const fMatch = /^F([1-9]|1[0-2])$/.exec(normalized)
  if (fMatch) return 0x70 + Number(fMatch[1]) - 1
  const code = normalized.charCodeAt(0)
  if ((code >= 0x30 && code <= 0x39) || (code >= 0x41 && code <= 0x5a)) return code
  return null
}
