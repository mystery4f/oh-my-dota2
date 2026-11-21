/**
 * 目标语言（#120）：中英以外的混编局里，「这句该译成哪种语言」必须由**方向**决定，而且只能有一种。
 *
 * 现状：两种方向的语言写死在提示词里（zh-en 只出英文、auto-zh 只出简体中文），`settings.targetLang`
 * 在别处没被读过。所以英文局、俄语局、东南亚局的中国玩家，看得到的中文/英文都不是队友的语言。
 *
 * 这里只回答一个问题：某条消息（已由 `#84` 判出方向）**唯一**的目标语言是什么。
 * 一次翻译只发一次请求——这条不是靠调用方自觉，而是这个函数只返回一个值，没有「可能两种」的形态。
 */
import type { TranslateDirection } from './ipc'

export interface TargetLanguage {
  /** BCP 47 风格的语言代码，直接进提示词。 */
  code: string
  /** 提示词里给人看的名字（用该语言自己的写法）。 */
  label: string
}

export const TARGET_LANGUAGES: readonly TargetLanguage[] = [
  { code: 'en', label: 'English' },
  { code: 'zh-CN', label: '简体中文' },
  { code: 'zh-TW', label: '繁體中文' },
  { code: 'ru', label: 'Русский' },
  { code: 'id', label: 'Bahasa Indonesia' },
  { code: 'fil', label: 'Filipino' },
  { code: 'th', label: 'ไทย' },
  { code: 'vi', label: 'Tiếng Việt' },
  { code: 'es', label: 'Español' },
  { code: 'pt', label: 'Português' },
  { code: 'tr', label: 'Türkçe' }
] as const

/** 两种方向各自的默认目标：中文行默认出英文，外来话默认出简体中文（= 改动前的行为）。 */
export const DEFAULT_TARGETS: Record<TranslateDirection, string> = {
  'zh-en': 'en',
  'auto-zh': 'zh-CN',
  'en-zh': 'zh-CN'
}

/** 设置里跟目标语言有关的那两项。 */
export interface TargetLanguageSettings {
  /** 外来话（英文/俄语/…）译成哪种语言；空 = 简体中文。 */
  targetLang: string
  /** 中文行译成哪种语言；空 = 英文。 */
  targetLang2: string
}

export function isKnownTarget(code: string): boolean {
  return TARGET_LANGUAGES.some((item) => item.code === code)
}

export function targetLabel(code: string): string {
  return TARGET_LANGUAGES.find((item) => item.code === code)?.label ?? code
}

/**
 * 一条消息唯一的目标语言。未知代码**回落默认**（不是报错也不是照抄）：
 * 手写设置文件里打错一个字，不该让整句翻译直接失败。
 */
export function resolveTargetLanguage(direction: TranslateDirection, settings: TargetLanguageSettings): string {
  const configured = direction === 'zh-en' ? settings.targetLang2 : settings.targetLang
  const code = configured.trim()
  if (code === '') return DEFAULT_TARGETS[direction]
  return isKnownTarget(code) ? code : DEFAULT_TARGETS[direction]
}

/** 目标跟默认不同时才需要额外那一句提示（默认行为由原提示词保证，别重复说）。 */
export function targetInstruction(direction: TranslateDirection, target: string): string | null {
  if (target === DEFAULT_TARGETS[direction]) return null
  return `Output language: ${targetLabel(target)} (${target}). Every word of the output must be in it — no English and no Chinese left behind except the channel tag and the nickname.`
}

/** 一行说明：`中文→英文 · 外来话→Русский`。 */
export function targetsLine(settings: TargetLanguageSettings): string {
  const zhTo = resolveTargetLanguage('zh-en', settings)
  const toZh = resolveTargetLanguage('auto-zh', settings)
  return `中文→${targetLabel(zhTo)} · 外来话→${targetLabel(toZh)}`
}
