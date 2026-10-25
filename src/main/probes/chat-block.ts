import { app } from 'electron'
import { hasHan, splitChatLine, takeHero, worthTranslating } from '../services/capture/capturer'
import { sameText } from '../services/session/durable-translator'

/**
 * 聊天行处理的纯逻辑回归（`--chat-block-probe`）。抓屏 OCR 移除后只剩 GSI 正文，
 * 但「怎么切前缀 / 翻不翻 / 是不是同一句 / 英雄名怎么抽」这几条判据全在这里冻结。
 */
export async function runChatBlockProbe(): Promise<void> {
  // 语言判定：正文里只要出现汉字就不翻（含中英混排）。判的是正文——`[英雄] [队友] [昵称] ⚔`
  // 这层前缀自带汉字，拿整行算会把 `lol`、`back off` 这种纯英文误判成中文。
  const langCases = [
    { line: '[lina] [队友] [队友A] ⚔ 别送我', body: '别送我', want: true },
    { line: '[pudge] [敌方] [敌人B] 🌐 lol', body: 'lol', want: false },
    { line: '[axe] [我] [Mystery] ⚔ 冲上路', body: '冲上路', want: true },
    { line: '[axe] [我] [Mystery] ⚔ back off', body: 'back off', want: false },
    { line: '[axe] [我] [Mystery] ⚔ gg 打得不错', body: 'gg 打得不错', want: true },
    { line: '[axe] [我] [Mystery] ⚔ push 中路 now', body: 'push 中路 now', want: true },
    { line: '[axe] [我] [Mystery] ⚔ gg wp', body: 'gg wp', want: false },
    { line: '[我] [Balance(Bot)] ⚔ hello', body: 'hello', want: false },
    { line: '[All] k1ng: push top pls', body: 'push top pls', want: false }
  ].map((item) => {
    const split = splitChatLine(item.line)
    return { ...item, stripped: split.body, prefix: split.prefix, got: hasHan(split.body) }
  })
  const langOk = langCases.every(
    (item) => item.got === item.want && (item.want || item.stripped === item.body)
  )
  // 前缀必须原样留在行首：翻译回填的是「前缀 + 译文」，前缀丢了就看不见谁说的。
  const prefixOk = langCases.every((item) => item.line.startsWith(item.prefix.trim()))

  // 没有可翻文字的行不能进模型队列：纯符号、纯数字、纯 emoji、单字符。
  const uselessCases = [
    { body: '???', want: false },
    { body: '。。。', want: false },
    { body: '666', want: false },
    { body: '😂😂😂', want: false },
    { body: 'g', want: false },
    { body: '啥', want: false },
    { body: '  ...  ', want: false },
    { body: 'gg', want: false },
    { body: 'gg wp', want: true },
    { body: '中路', want: false },
    { body: 'push 中路', want: true },
    { body: '? go ?', want: true }
  ].map((item) => ({ ...item, got: worthTranslating(item.body) }))
  const uselessOk = uselessCases.every((item) => item.got === item.want)

  // 同形判定：只比「字」，大小写/空白/标点符号的差别不算两个意思。
  const sameTextOk = sameText('gg', 'GG') && sameText('??? go', '???  go!') && !sameText('gg', 'wp')

  // 英雄名要能单独抽出来换成头像；频道词与普通行不能误伤。
  const heroCases = [
    { line: '[lina] [队友] [队友A] ⚔ 别送我', hero: 'lina', text: '[队友] [队友A] ⚔ 别送我' },
    { line: '[nevermore] [我] [Mystery] 🌐 ok', hero: 'nevermore', text: '[我] [Mystery] 🌐 ok' },
    { line: '[All] k1ng: push top', hero: undefined, text: '[All] k1ng: push top' },
    { line: '[队友] k1: hello', hero: undefined, text: '[队友] k1: hello' },
    { line: 'naked line', hero: undefined, text: 'naked line' }
  ]
  const heroOk = heroCases.every((item) => {
    const got = takeHero(item.line)
    return got.hero === item.hero && got.text === item.text
  })

  const ok = langOk && prefixOk && uselessOk && sameTextOk && heroOk
  console.log(
    'CHAT_BLOCK_PROBE',
    JSON.stringify({ ok, langOk, prefixOk, uselessOk, sameTextOk, heroOk, langCases, uselessCases })
  )
  app.exit(ok ? 0 : 1)
}
