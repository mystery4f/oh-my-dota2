/**
 * 拉丁 token 保真守卫：模型损坏缩写（bkb → bkg）或吞掉数字（200块钱 → need money）
 * 时，在译文进入聊天框/记账本之前把它抓出来。纯函数，零网络零模型。
 *
 * - zh-en（中→英）：源文里每一个拉丁 token 和每一段数字都必须出现在译文里
 *   （不区分大小写的包含判断 —— 包含判断偏宽松，宁可漏报也不误杀好译文）。
 * - en-zh / auto-zh（英→中）：只盯保真词表（keepVerbatim 词条 ∪ JARGON_KEEP）：
 *   普通英文单词（heart、tiny）本来就该译成中文，不参与判定；保真词只有在译文
 *   还是纯拉丁时才必须在场（模型复读原文/抄错缩写 bkb→bkg）。译文含汉字就说明
 *   真的译成了中文，rosh→肉山、smoke→开雾、bkb→黑皇杖都是对的，缺拉丁 token
 *   不算违例——按包含判定去比，守卫会把好译文扔掉、回退成英文原文交出去。
 */
import { KEEP_VERBATIM_TOKENS } from './dota-glossary'
import type { TranslateDirection } from './ipc'
import type { GuardEvent } from './guard-telemetry'

/** 汉字：en-zh 方向判断「这句到底译成中文了吗」的唯一依据。 */
const HAN = /\p{Script=Han}/u

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
  // en-zh / auto-zh：含汉字的译文已经译过，保真词的「中文形态」判不出来，别硬要求拉丁原文。
  if (!checkEverything && HAN.test(target)) return []
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

/**
 * 保真守卫的执行策略：违例就清场重试一次，再犯放弃回原文。
 * 会话车道（durable-translator 的 submitOnce）和直连车道（translateText）共用这一份，
 * 重试怎么跑由调用方给（retry），这里只管「判、重试、放弃」的顺序和留痕。
 * 返回原文 = 调用方按「译文 === 原文」处理：不落账、不发频道。
 */
export async function guardedTranslate(
  source: string,
  first: string,
  direction: TranslateDirection,
  via: 'session' | 'direct',
  retry: () => Promise<string>,
  /** 遥测出口：只有判违例才会被调用一次（结局已经定下来），正常译文一次都不调。 */
  report?: (event: GuardEvent) => void
): Promise<string> {
  const violations = latinTokenViolations(source, first, direction)
  if (violations.length === 0) return first
  console.log('TRANSLATE_GUARD_RETRY', JSON.stringify({ tokens: violations, via }))
  const translated = await retry()
  const again = latinTokenViolations(source, translated, direction)
  if (again.length > 0) {
    console.log('TRANSLATE_GUARD_GIVEUP', JSON.stringify({ tokens: again, translated: translated.slice(0, 200), via }))
    reportGuard(report, { at: new Date().toISOString(), via, direction, tokens: violations, retryTokens: again, outcome: 'gaveup' })
    return source
  }
  reportGuard(report, { at: new Date().toISOString(), via, direction, tokens: violations, retryTokens: [], outcome: 'recovered' })
  return translated
}

/** 遥测坏了不能反过来毁掉译文：出口抛错就当没接。 */
function reportGuard(report: ((event: GuardEvent) => void) | undefined, event: GuardEvent): void {
  try {
    report?.(event)
  } catch {
    // 守卫的结果已经定了，投递失败只丢一条计数。
  }
}
