/**
 * 拉丁 token 保真守卫：模型损坏缩写（bkb → bkg）或吞掉数字（200块钱 → need money）
 * 时，在译文进入聊天框/记账本之前把它抓出来。纯函数，零网络零模型。
 *
 * - zh-en（中→英）：源文里每一个拉丁 token 和每一段数字都必须出现在译文里
 *   （不区分大小写的包含判断 —— 包含判断偏宽松，宁可漏报也不误杀好译文）。
 * - en-zh / auto-zh（英→中）：只盯保真词表（keepVerbatim 词条 ∪ JARGON_KEEP）：
 *   源文里有 bkb/rosh/gg 这类缩写时译文必须留着它们，普通英文单词（heart、tiny）
 *   本来就该译成中文，不参与判定。
 */
import { KEEP_VERBATIM_TOKENS } from './dota-glossary'
import type { TranslateDirection } from './ipc'

/** 违例 token 列表（按源文出现顺序去重）；空数组 = 通过。 */
export function latinTokenViolations(source: string, target: string, direction: TranslateDirection): string[] {
  const haystack = target.toLowerCase()
  const checkEverything = direction === 'zh-en'
  const tokens = new Set<string>()
  for (const match of source.matchAll(/[a-z]+/gi)) {
    const token = match[0].toLowerCase()
    if (checkEverything || KEEP_VERBATIM_TOKENS.has(token)) tokens.add(token)
  }
  if (checkEverything) for (const match of source.matchAll(/\d+/g)) tokens.add(match[0])
  const violations: string[] = []
  for (const token of tokens) if (!haystack.includes(token)) violations.push(token)
  return violations
}

/**
 * 句末语气守卫：源句是问句/感叹句（以 ？/?、！/! 结尾）时，译文必须保住对应的
 * 目标语气标点（? / !）。句号不强制 —— 游戏速聊惯例就是丢句号，zh-en 提示词也
 * 明说丢句尾句号；但问号叹号丢了会改变句意（提问变陈述），所以要补回来。
 * 纯函数，零模型零网络：守卫失败不需要重试，直接修好译文。
 *
 * - 源句没有问号/叹号 → 译文原样返回（不主动加标点）
 * - 译文句尾已有 ?! 类标点 → 原样返回（?! 组合也算已带语气）
 * - 译文句尾带着句号（. 或 。）→ 摘掉句号再补语气标点，避免出现「info.?」
 */
export function ensureTerminalPunct(source: string, target: string): string {
  const src = source.trimEnd()
  const tail = /[?？！!]+$/.exec(src)?.[0] ?? ''
  const wantsQuestion = tail.includes('?') || tail.includes('？')
  const wantsBang = tail.includes('!') || tail.includes('！')
  if (!wantsQuestion && !wantsBang) return target
  const trimmed = target.trimEnd()
  if (!trimmed) return target
  // 目标文含汉字就补全角标点（en→zh 提示词也这么要求）；纯英文补半角。
  const cjk = /\p{Script=Han}/u.test(trimmed)
  const q = cjk ? '？' : '?'
  const b = cjk ? '！' : '!'
  const mark = wantsQuestion && wantsBang ? q + b : wantsQuestion ? q : b
  if (/[?？！!]$/.test(trimmed)) return target
  return trimmed.replace(/[.。]$/, '') + mark
}
