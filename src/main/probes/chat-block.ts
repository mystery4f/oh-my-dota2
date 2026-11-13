import { exitProbe } from './harness'
import { hasHan, renderChatLine, withChatBody, worthTranslating, type ChatLine } from '@shared/chat-line'
import { ChatCaptureService } from '../services/capture/capturer'
import { sameText } from '../services/session/durable-translator'

/**
 * 聊天行处理的纯逻辑回归（`--chat-block-probe`）。抓屏 OCR 移除后只剩 GSI，
 * 这里冻结三件事：值的形状（正文只此一份）、展示串的格式、译文回填不丢前缀；
 * 外加语言与「值不值得翻」的判据。
 */
export async function runChatBlockProbe(): Promise<void> {
  // 每一行既是输入（值）也是期望（上屏串）：格式改了这里会红。
  // 语言判定看的是 `body`：前缀里的「队友」「中文昵称」不再参与判断 ——
  // 以前拿整行判，中文昵称让 `lol` 被当成中文，那一句永远没有译文。
  const lineCases: Array<{ line: ChatLine; display: string; han: boolean }> = [
    {
      line: { hero: 'lina', relation: '队友', speaker: '队友A', channel: 'team', body: '别送我' },
      display: '[lina] [队友] [队友A] ⚔ 别送我',
      han: true
    },
    {
      line: { hero: 'pudge', relation: '敌方', speaker: '敌人B', channel: 'all', body: 'lol' },
      display: '[pudge] [敌方] [敌人B] 🌐 lol',
      han: false
    },
    {
      line: { relation: '我', speaker: 'Mystery', channel: 'team', body: '冲上路' },
      display: '[我] [Mystery] ⚔ 冲上路',
      han: true
    },
    {
      line: { relation: '我', speaker: 'Mystery', channel: 'team', body: 'back off' },
      display: '[我] [Mystery] ⚔ back off',
      han: false
    },
    {
      line: { relation: '我', speaker: 'Mystery', channel: 'team', body: 'gg 打得不错' },
      display: '[我] [Mystery] ⚔ gg 打得不错',
      han: true
    },
    {
      line: { relation: '我', speaker: 'Mystery', channel: 'team', body: 'push 中路 now' },
      display: '[我] [Mystery] ⚔ push 中路 now',
      han: true
    },
    {
      line: { relation: '我', speaker: 'Mystery', channel: 'team', body: 'gg wp' },
      display: '[我] [Mystery] ⚔ gg wp',
      han: false
    },
    {
      line: { relation: '我', speaker: 'Balance(Bot)', channel: 'team', body: 'hello' },
      display: '[我] [Balance(Bot)] ⚔ hello',
      han: false
    }
  ]
  const langOk = lineCases.every((item) => hasHan(item.line.body) === item.han)
  // 展示串格式只有一份：符号分频道、前缀顺序 [英雄] [关系] [昵称]。
  const displayOk = lineCases.every((item) => renderChatLine(item.line) === item.display)

  // 译文回填只换正文：前缀（频道 / 昵称 / 英雄 / 符号）原样留着，否则看不出是谁说的。
  const restoreOk = lineCases.every((item) => {
    const restored = withChatBody(item.display, item.line.body, '译文')
    const prefix = item.display.slice(0, item.display.lastIndexOf(item.line.body))
    return restored === `${prefix}译文`
  })

  // 回归用例：中文昵称只属于前缀，正文是纯英文，这句必须翻。
  const nicknameLine: ChatLine = { relation: '队友', speaker: '中文昵称', channel: 'team', body: 'lol' }
  const nicknameOk =
    renderChatLine(nicknameLine) === '[队友] [中文昵称] ⚔ lol' && !hasHan(nicknameLine.body)

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

  // 朗读边界（#32）：把 CaptureEffects 换成假实现，翻译账本就能脱离语音栈跑。
  // 三行里只有中文行和 666 走 settled 腿；英文行走翻译链，但探针同步退出，微任务不落地、不发网络。
  const announced: Array<{ entries: Array<{ translated: string | null; pending?: boolean }>; cutoff: number }> = []
  const service = new ChatCaptureService({
    onTranslated: (entries, cutoffMs) => announced.push({ entries: entries.map((entry) => ({ ...entry })), cutoff: cutoffMs })
  })
  service.pushMessages([
    { hero: 'axe', relation: '我', speaker: 'Mystery', channel: 'team', body: '冲上路' },
    { relation: '敌方', speaker: '敌人B', channel: 'all', body: '666' },
    { relation: '敌方', speaker: '敌人B', channel: 'all', body: 'push top pls' }
  ])
  const settled = announced[0]
  const effectsOk =
    announced.length === 1 &&
    settled !== undefined &&
    settled.cutoff > 0 &&
    settled.entries.length === 2 &&
    settled.entries.every((entry) => !entry.pending && entry.translated === null)
  const ok = langOk && displayOk && restoreOk && nicknameOk && uselessOk && sameTextOk && effectsOk
  console.log(
    'CHAT_BLOCK_PROBE',
    JSON.stringify({ ok, langOk, displayOk, restoreOk, nicknameOk, uselessOk, sameTextOk, effectsOk, uselessCases })
  )
  exitProbe(ok )
}