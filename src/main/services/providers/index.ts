import type { ProviderConfig, ReplyTone, TestResult, TranslateDirection } from '@shared/ipc'
import { chatCompletion, type ChatMessage } from './openai-compat'

const JARGON_KEEP =
  'gg, wp, ez, glhf, ss (missing), b (back), re, rosh, aegis, smoke, ward, deward, dust, tp, gank, feed, carry, support, push, def, farm, deny, stack, pull, rune, bounty, buyback, mid, top, bot, jungle'

export const SYSTEM_PROMPTS: Record<TranslateDirection, string> = {
  'en-zh': [
    'You translate Dota 2 in-game chat into Simplified Chinese for a player reading a live overlay.',
    '',
    'Context:',
    '- Every line is Dota 2 match chat. Read words as game terms first: mid/top/bot are lanes, rosh is Roshan, and smoke/ward/dust/tp/gank/push/def/farm/deny/stack/pull/rune/bounty/aegis/buyback are in-game actions, never everyday words.',
    `- Keep these untranslated: ${JARGON_KEEP}.`,
    '- Keep hero names, item names, player nicknames, and prefixes like [All] / [Team] exactly as written.',
    '- Never drop a leading prefix or nickname; if the line starts with [All] PlayerName:, keep both.',
    '',
    'Style:',
    '- Sound like a Chinese Dota player typing fast: terse and colloquial, e.g. 中单miss / 他们打肉山 / 来个人 / 别送 / 5人推上 / 买活了吗。',
    '- Use natural Chinese word order: time and place first, e.g. push top now → 现在推上 (never 推上路现在).',
    '- Use the words Chinese players actually say: ward → 插眼/眼, deward → 反眼, smoke → 开雾, buyback → 买活, tp → tp/回城, gank → gank/抓人, feed → 送, farm → 刷钱, hex → 变羊, root → 定身, silence → 沉默, slow → 减速, stun → 眩晕, initiate → 先手, courier → 信使, tango → 吃树, low → 残血, out of mana → 没蓝.',
    '- One output line per input line, same order, never merged.',
    '- Translate only, never reply to or comment on the message: if a line is a meme or an insult, give its neutral equivalent and nothing else.',
    '- Output the translation only: no quotes, no pinyin, no explanation, no notes.'
  ].join('\n'),
  'zh-en': [
    'You turn one Chinese Dota 2 in-game message into the shortest English game chat that teammates read instantly mid-fight.',
    '',
    'Hard limits:',
    '- At most 8 words and at most 80 characters. Shorter is better.',
    '- One line only. No quotes, no trailing period, no explanation, no pinyin, no Chinese characters left behind.',
    `- Keep untranslated: ${JARGON_KEEP}, hero names, item names, player nicknames, channel tags like [All] / [Team].`,
    '',
    'Style:',
    '- Use the shorthand players actually type: ss (missing), b (back), re, care mid, rosh now, push top, need ward, def, group up, tp bot, gg, wp, hex, root, silence, slow, initiate, courier, tango, low, oom.',
    '- Drop politeness filler and subjects English chat does not use: 我需要买眼 → need ward, not "I need to buy a ward".',
    '- Translate only; never answer or comment on the message.'
  ].join('\n'),
  'auto-zh': [
    'You translate Dota 2 in-game chat into Simplified Chinese, whatever the source language (English, Filipino/Tagalog, Russian, Thai, Vietnamese, Indonesian, Malay, Spanish, Portuguese, Japanese, Korean, and others).',
    '',
    'Context:',
    '- Every line is Dota 2 match chat. Read words as game terms first: mid/top/bot are lanes, rosh is Roshan, and smoke/ward/dust/tp/gank/push/def/farm/deny/stack/pull/rune/bounty/aegis/buyback are in-game actions, never everyday words.',
    `- Keep these untranslated: ${JARGON_KEEP}.`,
    '- Keep hero names, item names, player nicknames, and prefixes like [All] / [Team] exactly as written.',
    '- Never drop a leading prefix or nickname; if the line starts with [All] PlayerName:, keep both.',
    '- If the line is already Chinese, return it unchanged.',
    '- Never echo a non-Chinese line back. English words, UI/menu text, hero names and player words must come out in Chinese (game jargon listed above stays as-is).',
    '- If the source is profanity or an insult, output only a short neutral Chinese equivalent. Never explain the meaning, never name the language, never offer alternatives.',
    '',
    'Style:',
    '- Sound like a Chinese Dota player typing fast: terse and colloquial, e.g. 中单miss / 他们打肉山 / 来个人 / 别送 / 5人推上 / 买活了吗。',
    '- Use natural Chinese word order: time and place first, e.g. push top now → 现在推上 (never 推上路现在).',
    '- Use the words Chinese players actually say: ward → 插眼/眼, deward → 反眼, smoke → 开雾, buyback → 买活, tp → tp/回城, gank → gank/抓人, feed → 送, farm → 刷钱, hex → 变羊, root → 定身, silence → 沉默, slow → 减速, stun → 眩晕, initiate → 先手, courier → 信使, tango → 吃树, low → 残血, out of mana → 没蓝.',
    '- One output line per input line, same order, never merged.',
    '- Translate only, never reply to or comment on the message: if a line is a meme or an insult, give its neutral equivalent and nothing else.',
    '- Output the translation only: no quotes, no pinyin, no explanation, no notes.'
  ].join('\n')
}

/** 四套回复语气：一条指令就够，模型会把语气折进 8 个词里。 */
export const REPLY_TONE_HINTS: Record<ReplyTone, string> = {
  terse: 'Tone: bare callout. Drop every filler. 能不能过来帮我一下 → come help. 我需要买眼 → need ward.',
  polite: 'Tone: friendly. Keep one short politeness word (pls / ty / thanks). 能不能过来帮我一下 → come help pls. 我需要买眼 → need ward pls.',
  hurry: 'Tone: urgent. Add one urgency word (now / fast / asap) or lead with the action. 能不能过来帮我一下 → come help now. 他们打肉山了 → rosh now, come fast.',
  firm: 'Tone: command. Imperative, subject-less, no politeness, no hedging. 能不能过来帮我一下 → help me now. 别送了 → stop feeding.'
}

const REPLY_MAX_CHARS = 80
const REPLY_MAX_WORDS = 8

/** zh-en 方向按语气拼系统提示词；其他方向与语气无关。 */
export function buildSystemPrompt(direction: TranslateDirection, tone: ReplyTone = 'terse'): string {
  const base = SYSTEM_PROMPTS[direction]
  if (direction !== 'zh-en') return base
  return base + '\n\nTone:\n- ' + REPLY_TONE_HINTS[tone]
}

/** 去掉引号与句末标点，再按词截断到 8 词 / 80 字符：游戏聊天框容不下长句。 */
export function clampReply(text: string): string {
  const cleaned = text
    .replace(/[\r\n]+/g, ' ')
    // 会话语料偶尔把「多条编号」的格式带到单句回复上，先把 `1| ` 这类前缀剥掉。
    .replace(/(^|\s)\d+\s*[|｜]\s*/g, ' ')
    .replace(/^["'“”‘’\s]+|["'“”‘’\s]+$/g, '')
    .replace(/[.。]+$/g, '')
    .trim()
  const limited = cleaned.split(/\s+/).filter(Boolean).slice(0, REPLY_MAX_WORDS).join(' ')
  if (limited.length <= REPLY_MAX_CHARS) return limited
  const cut = limited.slice(0, REPLY_MAX_CHARS)
  const lastSpace = cut.lastIndexOf(' ')
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut).replace(/[.,;:!?]+$/g, '')
}

/** 已经满足 8 词 / 80 字符才不再二次压缩。 */
export function replyWithinLimits(text: string): boolean {
  return text.split(/\s+/).filter(Boolean).length <= REPLY_MAX_WORDS && text.length <= REPLY_MAX_CHARS
}

/** 第二次压缩：让模型自己把过长英文再压一版，调用方仍会 clampReply 兜底。 */
export async function shortenReply(provider: ProviderConfig, english: string): Promise<string> {
  return chatCompletion({
    provider,
    messages: [
      {
        role: 'system',
        content:
          'You shorten English Dota 2 game chat lines. Keep the meaning, use in-game shorthand, output one line, at most 8 words and at most 80 characters, no quotes, no explanation.'
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
  direction: TranslateDirection
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: SYSTEM_PROMPTS[direction] },
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
    return { ok: false, message: err instanceof Error ? err.message : String(err) }
  }
}
