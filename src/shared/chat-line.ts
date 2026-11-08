/**
 * 聊天行的纯缝：拆行、判语言、判值不值得翻、抽英雄 —— 主进程、探针、渲染端三方共用，
 * 不含 Electron 依赖。原 capture/chat-lines.ts（OCR 时代的拆行判据）与 capturer.ts 里的
 * 五条行规则在 #32 收进这里，翻译账本不再为了几条纯函数背着整条语音栈跑。
 */

/**
 * 聊天行解析与续行合并。
 *
 * Dota 2 每条玩家消息都以 `昵称: 内容` 或 `[All] 昵称: 内容` 开头；被自动换行切开的续行没有这个前缀，
 * 且左缩进与首行一致。实测（PaddleOCR，760×220 合成图）：行高 23–26px、相邻行空隙 3–5px，
 * 真实相邻两条消息的空隙同样只有 3–5px，所以「只看间距」无法区分续行与新消息，必须叠加前缀判据。
 */

export interface ParsedChatLine {
  /** `[All]` / `[Team]` 等频道标记，原样保留；无则空串。 */
  channel: string
  /** 玩家昵称；无则空串（系统消息、续行残留）。 */
  speaker: string
  /** 真正要翻译的正文。 */
  body: string
}

/** 频道标记：[All] / [Team] / [队友] / [观战] 之类，最长 12 字符。 */
const CHANNEL_RE = /^\s*(\[[^\]\n]{1,12}\])\s*/
/**
 * 昵称前缀：`昵称:` / `[队友] 昵称:` / `昵称 :`（真实 Dota 行在冒号前留空格）都算一条新消息。
 * 上限给到 48 字符：`[队友] Balance(Bot) [LISA.]` 这类带频道、带 (Bot) 后缀、带方括号的长名实测 26 字符，
 * 24 字符会把它判成「续行」，于是整屏消息被并成一条（实测 bug）。冒号后必须还有内容，避免把「wtf:」这类正文尾巴当前缀。
 */
const SPEAKER_RE = /^([^:：\n]{1,48}?)\s*[:：]\s*(?=\S)/

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
 * 拆出频道、昵称与正文。频道与昵称由调用方原样回填，模型只接触正文，
 * 因此翻译物理上无法弄丢玩家名。
 */
export function parseChatLine(text: string): ParsedChatLine {
  let rest = text.trim()
  let channel = ''
  const channelMatch = rest.match(CHANNEL_RE)
  if (channelMatch !== null) {
    channel = channelMatch[1]
    rest = rest.slice(channelMatch[0].length)
  }
  const speakerMatch = rest.match(SPEAKER_RE)
  if (speakerMatch !== null) {
    const speaker = speakerMatch[1].trim()
    const body = rest.slice(speakerMatch[0].length).trim()
    if (speaker.length > 0 && body.length > 0) return { channel, speaker, body }
  }
  return { channel, speaker: '', body: rest }
}

/** 回填前缀，与输入格式保持一致（`[All] 昵称: 正文`）。 */
export function formatChatPrefix(parsed: ParsedChatLine): string {
  const head = [parsed.channel, parsed.speaker === '' ? '' : `${parsed.speaker}:`]
    .filter((part) => part !== '')
    .join(' ')
  return head === '' ? '' : `${head} `
}

// —— 行规则（原 capturer.ts）：值不值得翻、怎么切前缀、英雄名抽取 ——

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

export function chatBody(text: string): string {
  return text.replace(/^(?:\[[^\]]*\]\s*)+[^\p{L}\p{N}]*/u, '').trim()
}

/**
 * 把一行拆成「装饰前缀 + 正文」。频道/英雄/关系/昵称/频道符号都不是玩家说的话：
 * 行 `[英雄] [关系] [昵称] ⚔ 正文` 交给 parseChatLine 会被它把 `[关系]` 当频道、
 * 把中文昵称留在正文里 —— 正文里一旦有汉字就会被判成「已经是中文」，
 * 整句跳过翻译，永远停在没有译文的状态。
 */
export function splitChatLine(raw: string): { prefix: string; body: string } {
  const parsed = parseChatLine(raw)
  const stripped = chatBody(raw)
  // 行首有几个 `[...]`：老 OCR 行只有一个频道（`[All] 昵称: 正文`），
  // GSI 行是固定的三段。后者绝不能让 parseChatLine 拆，否则正文里会留下装饰。
  const groups = raw.match(/^(?:\[[^\]]*\]\s*)+/)
  const decorated = (groups?.[0].match(/\[/g)?.length ?? 0) >= 2
  const body =
    stripped.length > 0 && (decorated || (hasHan(parsed.body) && !hasHan(stripped)))
      ? stripped
      : parsed.body
  const at = body.length > 0 ? raw.lastIndexOf(body) : -1
  return { prefix: at >= 0 ? raw.slice(0, at) : formatChatPrefix(parsed), body }
}

/** 频道词长得也像英雄短名，别把它们当头像。 */
const NOT_HERO = new Set(['all', 'team', 'say', 'say_team', 'game', 'lobby'])

/**
 * GSI 行前置的 `[英雄短名]` 单独抽出来：文案里不该再出现名字，浮层用头像代替。
 * 只认全小写字母数字下划线，`[All]`、`[队友]` 这类频道词原样留在文本里。
 */
export function takeHero(raw: string): { hero?: string; text: string } {
  const match = raw.match(/^\[([a-z][a-z0-9_]{1,29})\]\s+/)
  if (!match) return { text: raw }
  const slug = match[1]
  if (NOT_HERO.has(slug)) return { text: raw }
  return { hero: slug, text: raw.slice(match[0].length) }
}
