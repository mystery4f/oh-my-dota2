import type { ProviderConfig, ReplyTone, TestResult, TranslateDirection } from '@shared/ipc'
import { errorMessage } from '@shared/errors'
import { chatCompletion, type ChatMessage } from './openai-compat'

// 提示词只靠示例定风格：不下 85 行对照表，也不逐词下命令——术语模型自己认识，
// 硬约束（保真/词数/前缀/语气）由代码守卫兜底（translate-fidelity、clampReply、keepChannelTag）。
export const SYSTEM_PROMPTS: Record<TranslateDirection, string> = {
  'en-zh': [
    'You translate Dota 2 in-game chat into Simplified Chinese for a player reading a live overlay.',
    'Short and colloquial, the way Chinese players type.',
    '',
    'Format:',
    '- One output line per input line, same order, never merged.',
    '- Keep leading prefixes and nicknames: [All] X: stays [All] X:.',
    '- A question ends with ？, an exclamation with ！.',
    '- Translate only, never reply to or comment on the message. Output the translation only.',
    '',
    'Examples:',
    '- sf missing → 影魔不见了',
    '- bkb ready? → 黑皇杖好了吗',
    '- they smoked → 他们开雾了',
    '- need ward → 插个眼',
    '- care mid → 小心中路',
    '- push top → 推上',
    '- gg wp → gg wp',
    '- [All] well played → [All] 打得漂亮'
  ].join('\n'),
  'zh-en': [
    'You turn one Chinese Dota 2 in-game message into the shortest English game chat that teammates read instantly mid-fight.',
    'Write it the way players actually type: hero short forms, item acronyms, bare calls.',
    '',
    'Format:',
    '- One line only. At most {{MAX_WORDS}} words and at most {{MAX_CHARS}} characters.',
    '- No quotes, no pinyin, no explanation, no Chinese characters left behind.',
    '- Drop a trailing period, keep the ? of a question and the ! of an exclamation.',
    '- Keep channel tags and player nicknames: [All] X: stays.',
    '- Translate only; never answer or comment on the message.',
    '- A line starting with $ will be spoken aloud, not typed: return a natural short spoken sentence, not chat shorthand.',
    '',
    'Examples:',
    '- 影魔不见了 → sf ss',
    '- 敌法不见了 → am ss',
    '- 黑皇杖好了吗 → bkb ready?',
    '- 他们开雾了 → they smoked',
    '- 撤 → b',
    '- 别送了 → stop feeding',
    '- [All] 打得漂亮 → [All] wp',
    '',
    'Spoken examples:',
    '- $影魔不见了 → sf is missing',
    '- $别过来我会死 → don\'t come over, I\'ll die'
  ].join('\n'),
  'auto-zh': [
    'You translate Dota 2 in-game chat into Simplified Chinese, whatever the source language (English, Filipino/Tagalog, Russian, Thai, Vietnamese, Indonesian, Malay, Spanish, Portuguese, Japanese, Korean, and others).',
    'Short and colloquial, the way Chinese players type.',
    '',
    'Format:',
    '- One output line per input line, same order, never merged.',
    '- Keep leading prefixes and nicknames: [All] X: stays [All] X:.',
    '- If the line is already Chinese, return it unchanged.',
    '- Profanity or an insult comes out as a short neutral Chinese equivalent, no explanation.',
    '- Translate only, never reply to or comment on the message. Output the translation only.',
    '',
    'Examples:',
    '- sf missing → 影魔不见了',
    '- bkb ready? → 黑皇杖好了吗',
    '- they smoked → 他们开雾了',
    '- care mid → 小心中路',
    '- gg wp → gg wp'
  ].join('\n')
}

/** 四套回复语气：一条指令就够，模型会把语气折进 8 个词里。 */
export const REPLY_TONE_HINTS: Record<ReplyTone, string> = {
  terse: 'Tone: bare callout. Drop every filler. 能不能过来帮我一下 → come help. 我需要买眼 → need ward.',
  polite: 'Tone: friendly. Keep one short politeness word (pls / ty / thanks). 能不能过来帮我一下 → come help pls. 我需要买眼 → need ward pls.',
  hurry: 'Tone: urgent. Add one urgency word (now / fast / asap) or lead with the action. 能不能过来帮我一下 → come help now. 他们打肉山了 → rosh now, come fast.',
  firm: 'Tone: command. Imperative, subject-less, no politeness, no hedging. 能不能过来帮我一下 → help me now. 别送了 → stop feeding.'
}

/**
 * zh-en 词数上限：默认 16（面板「译文词数上限」可调，钳 4-32）。
 * 提示词（告诉模型写多长）与回复截断（游戏聊天框兜底）共用同一个值。
 */
export const DEFAULT_MAX_WORDS = 16

/** 面板来的坏值回默认：非数字/NaN 钳回默认，越界钳回 4..32 的整数。 */
export function maxWordsFromSettings(value: unknown): number {
  const n = typeof value === 'number' ? Math.round(value) : NaN
  if (!Number.isFinite(n)) return DEFAULT_MAX_WORDS
  return Math.min(32, Math.max(4, n))
}

/** 字符上限跟着词数走（保持 8 词=80 字的原比例），给游戏聊天框留安全边界。 */
const maxCharsFor = (maxWords: number): number => maxWords * 10

/** SYSTEM_PROMPTS 里的上限行存占位符，取用时按设置替换；无占位符的方向原样返回。 */
function withMaxWords(prompt: string, maxWords: number): string {
  return prompt
    .replace('{{MAX_WORDS}}', String(maxWords))
    .replace('{{MAX_CHARS}}', String(maxCharsFor(maxWords)))
}

/** zh-en 方向按语气拼系统提示词；其他方向与语气无关。maxWords 替换提示词里的上限占位符。 */
export function buildSystemPrompt(
  direction: TranslateDirection,
  tone: ReplyTone = 'terse',
  maxWords = DEFAULT_MAX_WORDS
): string {
  const base = withMaxWords(SYSTEM_PROMPTS[direction], maxWords)
  if (direction !== 'zh-en') return base
  return base + '\n\nTone:\n- ' + REPLY_TONE_HINTS[tone]
}

/** 编号契约：批量提交时每行独立翻译，禁止合并/拆分/乱序——capture 批量路径的格式保证。 */
const NUMBERED_CONTRACT_NOTE = [
  '',
  'When the user message contains numbered lines like "1| text", each numbered line is one independent chat line: reply with the same numbering and exactly one translation per line, in the same order, e.g. "1| 译文".',
  'Never merge, split, drop, reorder, or add lines.'
].join('\n')

/** 会话系统指令 = 方向提示词（短格式 + 示例）+ 编号契约；静态，会话按会话配置指令，不按行。 */
export function instructionsFor(
  direction: TranslateDirection,
  tone: ReplyTone = 'terse',
  maxWords = DEFAULT_MAX_WORDS
): string {
  return buildSystemPrompt(direction, tone, maxWords) + NUMBERED_CONTRACT_NOTE
}

/** 去掉引号与句末标点，再按词截断到上限词数/字符：游戏聊天框容不下长句。 */
export function clampReply(text: string, maxWords = DEFAULT_MAX_WORDS): string {
  const cleaned = text
    .replace(/[\r\n]+/g, ' ')
    // 会话语料偶尔把「多条编号」的格式带到单句回复上，先把 `1| ` 这类前缀剥掉。
    .replace(/(^|\s)\d+\s*[|｜]\s*/g, ' ')
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
    .replace(/[.。]+$/g, '')
    .trim()
  const limited = cleaned.split(/\s+/).filter(Boolean).slice(0, maxWords).join(' ')
  if (limited.length <= maxCharsFor(maxWords)) return limited
  const cut = limited.slice(0, maxCharsFor(maxWords))
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:!?]+$/g, '')
}

/** 已满足词数/字符上限才不再二次压缩。 */
export function replyWithinLimits(text: string, maxWords = DEFAULT_MAX_WORDS): boolean {
  return text.split(/\s+/).filter(Boolean).length <= maxWords && text.length <= maxCharsFor(maxWords)
}

/** 第二次压缩：让模型自己把过长英文再压一版，调用方仍会 clampReply 兜底。 */
export async function shortenReply(
  provider: ProviderConfig,
  english: string,
  maxWords = DEFAULT_MAX_WORDS
): Promise<string> {
  return chatCompletion({
    provider,
    messages: [
      {
        role: 'system',
        content:
          `You shorten English Dota 2 game chat lines. Keep the meaning, use in-game shorthand, output one line, at most ${maxWords} words and at most ${maxCharsFor(maxWords)} characters, no quotes, no explanation.`
      },
      { role: 'user', content: english }
    ],
    temperature: 0,
    maxTokens: 48,
    timeoutMs: 20_000
  })
}
/**
 * Reply translations must be a short English line. Occasionally the model explains
 * the draft instead ("The user said 你好 again, which is..."), which would be typed
 * into the game console as a chat message, so such answers are detected and retried.
 */
const COMMENTARY_RE =
  /(the user|user said|you said|he said|she said|which is|this means|it means|in chinese|as an ai|translation\s*[:：]|translated as|i cannot)/i

export function looksLikeCommentary(text: string): boolean {
  return COMMENTARY_RE.test(text)
}

/** Chat channels like [All] / [Team] must survive translation; re-add them if dropped. */
export function keepChannelTag(original: string, translated: string): string {
  const tag = original.match(/^\s*(\[[^\]]{1,12}\])/)
  if (!tag) return translated
  return translated.startsWith(tag[1]) ? translated : `${tag[1]} ${translated}`
}

/** 模型爱加引号、"Translation:" 前缀、思考标签残留，甚至把同一句吐两遍 - 逐层剥掉。 */
export function sanitizeTranslation(output: string): string {
  const cleaned = output
    .replace(/<\/?[a-z][^<>]{0,20}>/gi, ' ')
    .split(/\r?\n/)
    .map((line) =>
      line
        .trim()
        .replace(/^(?:translation|translated|译文|翻译)\s*[:：]\s*/i, '')
        .replace(/^["'“”‘’`]+/, '')
        .replace(/["'“”‘’`]+$/, '')
        .trim()
    )
    .filter((line) => line.length > 0)
    .join('\n')
  return collapseRepeatedHalf(cleaned)
}

/** "你好菜啊 笨蛋你好菜啊 笨蛋" 这类整句重复（模型续写自重复）折叠成一半。 */
function collapseRepeatedHalf(text: string): string {
  const half = Math.floor(text.length / 2)
  if (half < 4) return text
  const head = text.slice(0, half).trim()
  const tail = text.slice(half).trim()
  return head === tail ? head : text
}

export async function translateText(
  provider: ProviderConfig,
  text: string,
  direction: TranslateDirection,
  maxWords = DEFAULT_MAX_WORDS
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: withMaxWords(SYSTEM_PROMPTS[direction], maxWords) },
    { role: 'user', content: text }
  ]
  const raw = await chatCompletion({ provider, messages, temperature: 0 })
  return keepChannelTag(text, sanitizeTranslation(raw))
}

export async function testProvider(provider: ProviderConfig): Promise<TestResult> {
  const started = Date.now()
  try {
    const reply = await chatCompletion({
      provider,
      messages: [{ role: 'user', content: 'Reply with exactly: OK' }],
      temperature: 0,
      maxTokens: 256,
      // mimo 冷启动实测 11.5s（热态 2.5-3.2s），15s 太紧会把正常连接判成失败。
      timeoutMs: 30_000
    })
    return {
      ok: true,
      message: `${provider.model} replied "${reply.slice(0, 40)}"`,
      latencyMs: Date.now() - started
    }
  } catch (err) {
    return { ok: false, message: errorMessage(err) }
  }
}
