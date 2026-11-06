import { BrowserWindow } from 'electron'
import { errorMessage } from '@shared/errors'
import { IPC, type CaptureEntry, type CaptureStatus } from '@shared/ipc'
import { chatBody, hasHan, normalizeLine, splitChatLine, takeHero, worthTranslating } from '@shared/chat-line'
import { translateLines } from '../session/durable-translator'
import { announceEntries } from '../voice/speech'
import { loadSettings } from '../settings'

import { HISTORY_MAX_ROWS } from '@shared/overlay-ledger'
/**
 * 存续窗口：同一句话在 60 条内重复出现就不再上屏。
 * Dota 的 GSI 会连推 26 帧左右，这里也顺手兜住重复投递。
 */
const RECENT_MAX = 60

/** Windows OCR 会在汉字之间塞空格；历史数据与 OCR 行仍走这条清理。 */
function cleanCjkSpacing(text: string): string {
  return text.replace(
    /(?<=[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])\s+(?=[\u4e00-\u9fff\u3000-\u303f\uff00-\uffef])/g,
    ''
  )
}


/** 侧效应边界：译文落地（或判定免翻）后的朗读出口。探针注入假实现，账本就能脱离语音栈跑（#32）。 */
export interface CaptureEffects {
  onTranslated(entries: CaptureEntry[], cutoffMs: number): void
}

function defaultCaptureEffects(): CaptureEffects {
  return { onTranslated: (entries, cutoffMs) => announceEntries(entries, cutoffMs) }
}
/**
 * 聊天正文的收口点：Dota 推来的每一行在这里去重、判语言、送翻译、上屏。
 *
 * 抓屏 OCR 整条链路已经移除（Dota 的 `chat_message` 事件给的是同一条消息的
 * 原文，还带玩家与频道，比截图识别准且零延迟）。这个类因此只剩「投递 →
 * 翻译 → 广播」三件事，名字保留是为了不再动调用方。
 */
export class ChatCaptureService {
  private readonly effects: CaptureEffects

  constructor(effects: CaptureEffects = defaultCaptureEffects()) {
    this.effects = effects
  }

  private running = false
  private recent: { key: string; text: string }[] = []
  private recentSet = new Set<string>()
  private translateChain: Promise<void> = Promise.resolve()
  private lastTranslateMs: number | null = null
  private lastError: string | null = null
  private totalEntries = 0
  private seq = 0
  private listeners = new Set<(entries: CaptureEntry[]) => void>()
  private updateListeners = new Set<(entries: CaptureEntry[]) => void>()
  // 最新一拍捕获的时间戳：朗读在宣布（announce）时对照它丢弃已被更新一拍顶掉的旧条目，
  // 否则上一条的译文晚到（翻译抖动可达十几秒）就会插在新消息之后被念出来。
  private lastPushAt = 0
  private stateListeners = new Set<(status: CaptureStatus) => void>()

  onStateChange(callback: (status: CaptureStatus) => void): () => void {
    this.stateListeners.add(callback)
    return () => this.stateListeners.delete(callback)
  }

  private notifyState(): void {
    const status = this.status()
    for (const callback of this.stateListeners) callback(status)
  }

  onEntries(callback: (entries: CaptureEntry[]) => void): () => void {
    this.listeners.add(callback)
    return () => this.listeners.delete(callback)
  }

  onEntryUpdates(callback: (entries: CaptureEntry[]) => void): () => void {
    this.updateListeners.add(callback)
    return () => this.updateListeners.delete(callback)
  }

  /** 只翻「开关」：正文由 GSI 推来，没有需要启动的采样循环。 */
  async start(): Promise<CaptureStatus> {
    this.running = true
    this.lastError = null
    this.notifyState()
    return this.status()
  }

  async stop(): Promise<CaptureStatus> {
    this.running = false
    this.notifyState()
    return this.status()
  }

  pushMessages(messages: Array<{ text: string; own?: boolean; speaker?: string }>): void {
    // 先盖章再构造条目：本拍条目的 ts 都 >= lastPushAt，宣布时不会被自己的 cutoff 判成过期。
    this.lastPushAt = Date.now()
    const fresh = messages
      .map((line) => ({ text: line.text.trim(), own: line.own === true, speaker: line.speaker }))
      .filter((line) => normalizeLine(line.text).length >= 2)
    if (fresh.length === 0) return
    for (const line of fresh) this.remember(normalizeLine(line.text), line.text)
    const pending = fresh.map((line) => {
      const entry = this.makeEntry(line.text, null, true)
      // own 只影响归属标注，不影响上屏：用户要的是「只看一个地方」，自己那句也得看得到。
      return {
        ...entry,
        ...(line.own ? { own: true } : {}),
        ...(line.speaker ? { speaker: line.speaker } : {})
      }
    })
    this.broadcast(IPC.CAPTURE_ENTRIES, pending)

    // 两种行都不必翻，直接收尾成「没有译文」，浮层在只译文模式下照样显示原文：
    // 本来就是中文的（hasHan），以及没有可翻文字的（纯符号/纯数字/单字符）。
    const needs: CaptureEntry[] = []
    const settled: CaptureEntry[] = []
    for (const entry of pending) {
      const body = chatBody(entry.original)
      if (hasHan(body) || !worthTranslating(body)) settled.push(entry)
      else needs.push(entry)
    }
    if (settled.length > 0) {
      this.totalEntries += settled.length
      const done = settled.map((entry) => ({ ...entry, translated: null, pending: false }))
      this.broadcast(IPC.CAPTURE_UPDATE, done)
      // 不用翻 ≠ 不用念：中文玩家说的原话正是要听的内容。
      this.effects.onTranslated(done, this.lastPushAt)
    }
    if (needs.length === 0) return
    this.translateChain = this.translateChain
      .then(() => this.translatePending(needs.map((entry) => entry.original), needs))
      .catch((err: unknown) => {
        // 队列是一条 Promise 链，一节坏掉会把后面所有翻译冻住且毫无声响。
        this.lastError = `translate chain: ${errorMessage(err)}`
        console.log('TRANSLATE_CHAIN_FAILED', this.lastError)
      })
  }

  status(): CaptureStatus {
    return {
      running: this.running,
      source: 'gsi',
      totalEntries: this.totalEntries,
      lastTranslateMs: this.lastTranslateMs,
      lastError: this.lastError
    }
  }

  /** 对局结束：清掉「说过的话」窗口，并把浮层清空（下一局不该带着上一局的行）。 */
  endMatchSession(): void {
    this.recent = []
    this.recentSet.clear()
    this.lastError = null
    this.broadcast(IPC.CAPTURE_REPLACE, [])
    this.notifyState()
  }

  private async translatePending(fresh: string[], pending: CaptureEntry[]): Promise<void> {
    const translateStarted = Date.now()
    try {
      const settled = await this.buildEntries(fresh)
      this.lastTranslateMs = Date.now() - translateStarted
      const done = new Map(settled.map((entry) => [entry.original, entry]))
      const filled = pending.map((entry) => {
        const hit = done.get(entry.original)
        return {
          ...entry,
          translated: hit ? hit.translated : null,
          cached: hit ? hit.cached : undefined,
          error: hit?.error,
          pending: false
        }
      })
      this.totalEntries += filled.length
      this.broadcast(IPC.CAPTURE_UPDATE, filled)
      // 译文落地就交给朗读：pending 的行会被 decideSpeak 拒掉，这里不必再判。
      this.effects.onTranslated(filled, this.lastPushAt)
    } catch (err) {
      this.lastError = errorMessage(err)
    }
  }

  private broadcast(channel: string, entries: CaptureEntry[]): void {
    this.rememberLedger(channel, entries)
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, entries)
    if (channel === IPC.CAPTURE_ENTRIES) {
      for (const callback of this.listeners) callback(entries)
    } else {
      for (const callback of this.updateListeners) callback(entries)
    }
  }

  /** 呼出面板的 200 条历史：广播即落账本，按 id 原位更新，替换事件整表清空。 */
  private ledger: CaptureEntry[] = []
  private rememberLedger(channel: string, entries: CaptureEntry[]): void {
    if (channel === IPC.CAPTURE_REPLACE) {
      this.ledger = []
      return
    }
    for (const entry of entries) {
      const index = this.ledger.findIndex((row) => row.id === entry.id)
      if (index >= 0) this.ledger[index] = entry
      else this.ledger.push(entry)
    }
    if (this.ledger.length > HISTORY_MAX_ROWS) this.ledger = this.ledger.slice(-HISTORY_MAX_ROWS)
  }

  /** 呼出面板读历史：只给最近 n 条，最新在尾部。 */
  history(n = HISTORY_MAX_ROWS): CaptureEntry[] {
    return this.ledger.slice(-n)
  }

  private remember(key: string, text: string): void {
    this.recent.push({ key, text })
    this.recentSet.add(key)
    if (this.recent.length > RECENT_MAX) {
      const dropped = this.recent.shift()
      if (dropped && !this.recent.some((item) => item.key === dropped.key)) {
        this.recentSet.delete(dropped.key)
      }
    }
  }

  private async buildEntries(fresh: string[]): Promise<CaptureEntry[]> {
    const provider = loadSettings().provider
    if (provider.id !== 'ollama' && !provider.apiKey) {
      this.lastError = `翻译失败：模型服务 "${provider.id}" 需要 API Key`
      return fresh.map((raw) => this.makeEntry(raw, null))
    }

    let firstError: string | null = null
    // 频道与昵称由代码原样回填，只把正文交给模型 —— 玩家名不可能被译丢。
    const splits = fresh.map((raw) => splitChatLine(raw))
    const pending: { index: number; body: string }[] = []
    splits.forEach((split, index) => {
      // 与 pushMessages 用同一把尺子：中文、纯符号、单字符都不进队列。
      if (!hasHan(split.body) && worthTranslating(split.body)) pending.push({ index, body: split.body })
    })

    // 谁真的被送去翻译了：只有这些行在失败时该背「翻译服务不可用」的标记。
    const attempted = new Set(pending.map((item) => item.index))
    const translated = new Map<number, string>()
    const cachedRows = new Map<number, boolean>()
    if (pending.length > 0) {
      try {
        // 一次请求翻译整屏新行：会话上下文只增一次，也让模型看到同一屏的同伴信息。
        // 记账本在 translateLines 里统一处理（命中的行不会进这个请求）。
        const marks: boolean[] = []
        const block = await translateLines(
          provider,
          pending.map((item) => item.body),
          'auto-zh',
          marks
        )
        block.forEach((value, i) => {
          const item = pending[i]
          if (!item || !value) return
          translated.set(item.index, value)
          // 记账本命中的行单独标出来：面板和浮层要能一眼分清「词库」还是「现翻」。
          if (marks[i] === true) cachedRows.set(item.index, true)
        })
      } catch (err) {
        firstError ??= `translate: ${errorMessage(err)}`
      }
    }

    const entries = fresh.map((raw, index): CaptureEntry => {
      const value = translated.get(index)
      // 失败要看得见：只有真的送进队列却没翻成的行才标错，中文行与不值得翻的行不背这个锅。
      const failed = firstError !== null && attempted.has(index)
      if (!value) return failed ? { ...this.makeEntry(raw, null), error: firstError ?? undefined } : this.makeEntry(raw, null)
      const restored = `${splits[index].prefix}${value.trim()}`.trim()
      const entry = this.makeEntry(raw, restored || null)
      return cachedRows.get(index) === true ? { ...entry, cached: true } : entry
    })
    if (firstError) this.lastError = firstError
    return entries
  }

  private makeEntry(original: string, translated: string | null, pending = false): CaptureEntry {
    const { hero, text } = takeHero(original)
    return {
      id: `${Date.now()}-${this.seq++}`,
      ts: Date.now(),
      pending,
      hero,
      original: cleanCjkSpacing(text),
      translated
    }
  }
}

let service: ChatCaptureService | null = null

export function getCaptureService(): ChatCaptureService {
  if (!service) service = new ChatCaptureService()
  return service
}
