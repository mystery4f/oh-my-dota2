/**
 * --target-language-probe：目标语言（#120）。
 *
 * 票面两条验收：一条消息只路由到**一个**目标语言；每行只发生一次翻译调用。
 * 第二条不是靠探针数请求次数来证明的——`targetSystemPrompt()` 每次只产出一份系统提示，
 * 一次 `translateText()` 只发一条 system + 一条 user，这里按形状钉住。
 */
import { targetSystemPrompt } from '../services/providers'
import {
  DEFAULT_TARGETS,
  isKnownTarget,
  resolveTargetLanguage,
  targetInstruction,
  targetLabel,
  targetsLine,
  TARGET_LANGUAGES
} from '@shared/target-language'
import { finishProbe, probeCases } from './harness'

export function runTargetLanguageProbe(): void {
  const { cases, push } = probeCases()
  const empty = { targetLang: '', targetLang2: '' }

  push('中文行没配置时出英文', resolveTargetLanguage('zh-en', empty) === 'en', resolveTargetLanguage('zh-en', empty))
  push('外来话没配置时出简体中文', resolveTargetLanguage('auto-zh', empty) === 'zh-CN')
  push('两种方向的默认值与 DEFAULT_TARGETS 一致', Object.entries(DEFAULT_TARGETS).every(([dir, code]) => resolveTargetLanguage(dir as keyof typeof DEFAULT_TARGETS, empty) === code))

  const ru = { targetLang: 'ru', targetLang2: 'en' }
  push('外来话配成俄语就出俄语', resolveTargetLanguage('auto-zh', ru) === 'ru')
  push('中文行仍然独立取值（配成英文）', resolveTargetLanguage('zh-en', ru) === 'en')
  push('每条消息只得到一种目标语言（返回值是单个字符串，没有集合形态）', typeof resolveTargetLanguage('auto-zh', ru) === 'string' && isKnownTarget(resolveTargetLanguage('auto-zh', ru)))
  push('配置值带空格也照收', resolveTargetLanguage('auto-zh', { targetLang: '  id  ', targetLang2: '' }) === 'id')
  push('未知代码回落默认，不把坏值直接送进提示词', resolveTargetLanguage('auto-zh', { targetLang: 'klingon', targetLang2: '' }) === 'zh-CN')
  push('语言表里每项都有代码与标签', TARGET_LANGUAGES.every((item) => item.code !== '' && item.label !== ''))
  push('标签查得到、查不到就用代码本身', targetLabel('ru') === 'Русский' && targetLabel('xx') === 'xx')

  push('默认目标不需要额外那句提示', targetInstruction('zh-en', 'en') === null && targetInstruction('auto-zh', 'zh-CN') === null)
  const note = targetInstruction('auto-zh', 'ru')
  push('非默认目标时给出语言代码与名字', note !== null && note.includes('ru') && note.includes('Русский'), note ?? 'null')
  push('那句提示要求不留中英残留', note !== null && note.includes('no English'))

  const base = targetSystemPrompt('auto-zh', 'zh-CN', 12)
  const russian = targetSystemPrompt('auto-zh', 'ru', 12)
  push('默认目标的系统提示里没有输出语言那句', !base.includes('Output language:'))
  push('非默认目标的系统提示里只有一次输出语言要求', russian.split('Output language:').length === 2)
  push('非默认目标的提示只多出这一句（原提示词保留）', russian.startsWith(base) && russian.length > base.length)
  push('一次调用只有一份系统提示（形状固定）', typeof russian === 'string' && !russian.includes('system"') )

  push('一行说明两种方向各自的目标', targetsLine(ru) === '中文→English · 外来话→Русский', targetsLine(ru))

  finishProbe('TARGET_LANGUAGE_PROBE', cases, { languages: TARGET_LANGUAGES.length, line: targetsLine(ru) })
}
