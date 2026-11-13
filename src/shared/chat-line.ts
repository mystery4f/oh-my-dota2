/**
 * 聊天行的纯缝：一行聊天的值、展示串、语言判据 —— 主进程、探针、渲染端三方共用，不含 Electron 依赖。
 *
 * 这里只有一份「一行聊天」的定义。以前 GSI 先拼成 `[英雄] [关系] [昵称] ⚔ 正文`，下游再拆回
 * 正文、昵称、英雄三遍（拆行的、抽英雄的、抽说话人的各一套，关系词表抄了三次）。拆漏一次
 * 就是真 bug：中文昵称留在正文里，`hasHan` 判成「已经是中文」，那一句永远不会有译文。
 * 现在值是值、展示是展示：正文只从 `body` 取，展示串只为上屏和日志。
 */

/** 一行聊天。GSI 直接给结构；其它来源先拆成这个形状再往下走。 */
export interface ChatLine {
  /** 说话人的英雄短名（`nevermore`）：GSI 才有，浮层用它换头像。 */
  hero?: string
  /** 哪边的：GSI 的关系词（我 / 队友 / 敌方 / 玩家）。 */
  relation?: string
  /** 昵称。 */
  speaker: string
  /** 频道：`all` = 所有人（channel_type 11），`team` = 队伍（12）。 */
  channel?: 'all' | 'team'
  /** 真正要翻译的正文：只有这一份。 */
  body: string
  /** 自己发的：照常上屏，朗读跳过。 */
  own?: boolean
}

/** 队伍频道符号：展示串靠它一眼看出「谁能看见」。 */
export const TEAM_CHAT_SYMBOL = '⚔'
/** 所有人频道符号。 */
export const ALL_CHAT_SYMBOL = '🌐'

/** 展示用的一行：`[英雄] [关系] [昵称] ⚔ 正文`。翻译只认 `body`，不要把它拆回来。 */
export function renderChatLine(line: ChatLine): string {
  const symbol = line.channel === 'all' ? ALL_CHAT_SYMBOL : TEAM_CHAT_SYMBOL
  const head = [line.hero, line.relation, line.speaker]
    .filter((part): part is string => part !== undefined && part !== '')
    .map((part) => `[${part}]`)
    .join(' ')
  return `${head} ${symbol} ${line.body}`.trim()
}

/**
 * 把译文放回展示串：只换正文，前缀（频道 / 昵称 / 英雄 / 符号）原样不动。
 * 位置用同一个值里的正文找，不靠猜字符串。
 */
export function withChatBody(display: string, body: string, translated: string): string {
  const value = translated.trim()
  if (body.length === 0) return value
  const at = display.lastIndexOf(body)
  return (at >= 0 ? `${display.slice(0, at)}${value}` : value).trim()
}

/** 去空白、去标点、去符号后的小写串：判重、判回声、缓存键、识别稿比对共用这一份折叠规则（OCR 的标点/大小写噪声不该算新消息）。 */
export function normalizeLine(text: string): string {
  return text.replace(/[\s\p{P}\p{S}]+/gu, '').toLowerCase()
}

/**
 * 游戏只认可打印 ASCII：CJK、换行、引号都会在按键注入里变成空白或残句。
 *
 * 两个写法通道（聊天框整句粘贴、控制台逐字打字）此前各写一遍同样的清洗，
 * 规则一样却各自为政——改一处就漏另一处，所以只留这一份。
 */
export function toPrintableAscii(text: string): string {
  return text.replace(/[^\x20-\x7E]/g, ' ').replace(/\s+/g, ' ').trim()
}

/**
 * 只要正文里出现一个汉字就不翻译 —— 中文玩家的原话就是目标语言，
 * 中英混排（`push 中路`）也按中文算，翻过去只会把「中路」再糟蹋一遍。
 */
export function hasHan(text: string): boolean {
  return /[\u3400-\u9fff]/.test(text)
}

/**
 * 这条正文值不值得翻。两种行不值得，都不该进模型队列：
 * 没有字母也没有汉字（`???`、`。。。`、`666`、纯 emoji）——没有可翻的文字；
 * 少于三个字符（`G`、`gg`、`ok`、`嗯`）——一两个字没有上下文，模型只会把原样吐回来。
 * 与 `hasHan` 的分工：hasHan 判「已经是目标语言」，这里判「根本没有可翻的文字」。
 */
export function worthTranslating(body: string): boolean {
  const trimmed = body.replace(/\s+/gu, ' ').trim()
  if (trimmed.length === 0) return false
  if (!/[A-Za-z]/.test(trimmed) && !hasHan(trimmed)) return false
  return [...trimmed].length > 2
}
