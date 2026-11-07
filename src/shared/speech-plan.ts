/**
 * 语音合成计划值：一次合成用什么引擎、哪个嗓子、什么语言、出什么格式、多快多高。
 *
 * 朗读 / 试听 / 声出 / 声出测试四条腿都从这里取同一份判断。以前引擎与音色的选法
 * 各写了一遍：试听把 system 与 offline 都折成 Edge、音色永远取朗读的 Edge 嗓，
 * 于是面板选「离线音色」点试听听到的是 Edge 的声音（`tts.ts` 老写法见 git 历史）。
 *
 * 纯函数、不碰 electron：`--tts-pipeline-probe` 与 `--voice-out-probe` 直接喂数据断言。
 */
import { OFFLINE_VOICES, type OfflineVoiceId, type VoiceOutEngine } from './ipc'
import type { TtsVoiceOption } from './tts-voices'

/** 四个引擎：声出侧只有三个（系统嗓子合成不出能送进频道的声音），朗读多一个 system。 */
export type SpeechEngine = VoiceOutEngine | 'system'

export const DEFAULT_SPEECH_ENGINE: SpeechEngine = 'edge'

/** 手编 JSON / 老配置文件里的垃圾值一律打回 edge；system 是朗读的合法选项，不在这里拦。 */
export function normalizeSpeechEngine(raw: unknown): SpeechEngine {
  return raw === 'offline' || raw === 'sovits' || raw === 'system' ? raw : 'edge'
}

/** 一句音频的容器格式：mp3 或 wav。system 没有（它不出音频）。 */
export type SpeechMime = 'audio/mpeg' | 'audio/wav'

/**
 * 每个引擎出什么格式。system 不出音频（浮层拿文本走系统嗓子），其余三种由合成端决定：
 * edge 回 mp3，offline / sovits 回 wav。渲染层靠它解 Blob，主进程靠它塞 VoicePreviewResult——
 * 「离线 WAV 当 mp3 播成静音」就是这条信息在两个地方各写一遍的那次事故。
 */
export const SPEECH_MIME: Record<Exclude<SpeechEngine, 'system'>, SpeechMime> = {
  edge: 'audio/mpeg',
  offline: 'audio/wav',
  sovits: 'audio/wav'
}

/**
 * 语言看文本本身（含 CJK 即中文），不看用户设置也不看译文来源。
 * 朗读、声出、试听本来各写了一遍正则，判据必须只有一份，否则同一条文本三条腿三种语言。
 */
export function speechLang(text: string): 'zh' | 'en' {
  return /[\u3400-\u9fff]/.test(text) ? 'zh' : 'en'
}

export interface SpeechPlanInput {
  /** 面板上这一腿的引擎选择；垃圾值打回 edge。 */
  engine?: unknown
  /** 这一腿记住的音色：edge 存神经嗓 id，offline 存本地嗓 id，sovits 不用。 */
  voice?: unknown
  /**
   * 朗读式两条音色槽：离线嗓另存一个字段，用哪个由引擎决定。
   * 声出只有一个字段，不传即可——两条槽的差别本来就在设置结构里，不在选法里。
   */
  offlineVoice?: unknown
  rate: number
  pitch: number
  segmentChars?: number
  /** 要念的文本：决定语言。 */
  text: string
  /** 这一腿允许的 Edge 嗓清单：声出只认英文嗓、朗读只认中文嗓——清单归调用方，选法归这里。 */
  edgeVoices?: readonly TtsVoiceOption[]
  defaultEdgeVoice?: string
}

export interface SpeechPlan {
  engine: SpeechEngine
  /** 归一化后的嗓音 id：offline 一定是离线清单里的，edge 一定是该腿清单里的，sovits 为空串。 */
  voice: string
  lang: 'zh' | 'en'
  /** system 为 null（不出音频）。 */
  mime: 'audio/mpeg' | 'audio/wav' | null
  rate: number
  pitch: number
  segmentChars: number
}

/** 引擎认的语速/音高区间：夹一次就够，四条腿与两个适配器共用（以前各夹一遍）。 */
const clampRate = (rate: number): number => Math.min(2, Math.max(0.5, Number.isFinite(rate) ? rate : 1))
const clampPitch = (pitch: number): number => Math.min(1.3, Math.max(0.7, Number.isFinite(pitch) ? pitch : 1))

/** 音色不在对应清单里一律打回该引擎默认；GV 不选嗓（音色由参考音频/权重决定）。 */
export function resolveSpeechPlan(input: SpeechPlanInput): SpeechPlan {
  const engine = normalizeSpeechEngine(input.engine)
  const lang = speechLang(input.text)
  const base = {
    engine,
    lang,
    mime: engine === 'system' ? null : SPEECH_MIME[engine],
    rate: clampRate(input.rate),
    pitch: clampPitch(input.pitch),
    segmentChars: input.segmentChars ?? 30
  }
  if (engine === 'sovits') return { ...base, voice: '' }
  if (engine === 'offline') {
    const raw = input.offlineVoice ?? input.voice
    const hit = OFFLINE_VOICES.find((item) => item.id === raw)
    return { ...base, voice: (hit?.id ?? OFFLINE_VOICES[0].id) as OfflineVoiceId }
  }
  if (engine === 'system') return { ...base, voice: '' }
  const allowed = input.edgeVoices
  const voice =
    allowed === undefined
      ? (typeof input.voice === 'string' ? input.voice : (input.defaultEdgeVoice ?? ''))
      : allowed.some((item) => item.id === input.voice)
        ? (input.voice as string)
        : (input.defaultEdgeVoice ?? allowed[0]?.id ?? '')
  return { ...base, voice }
}

/**
/**
 * 引擎失败的原因短语。各腿自己接后缀（「这句不出声」/「试听失败」），
 * 但「离线失败是没装模型、GV 失败是缺某一环」这个判断只有一份——
 * 把断网的提示报给离线用户，是最容易写出来又最难发现的错。
 *
 * GV 那一条故意把四环都念一遍：它就一句话的篇幅，说清「可能是哪几样」，
 * 具体缺哪一环由对讲页的就绪行点名（同一个 reason 枚举，不会说两套话）。
 */
export function speechFailHint(engine: SpeechEngine): string {
  if (engine === 'offline') return '离线引擎合成失败（模型没装好或推理失败）'
  if (engine === 'sovits') return 'GV 合成失败（引擎、音色包、服务或参考音频缺一环，对讲页就绪行会点名）'
  if (engine === 'system') return '系统嗓子不出音频'
  return 'Edge 合成失败（断网或接口不可用）'
}
