import { BrowserWindow } from 'electron'
import { IPC, type CaptureEntry, type CaptureStatus } from '@shared/ipc'
import { formatChatPrefix, normalizeLine, parseChatLine } from './chat-lines'
import { translateLines } from '../session/durable-translator'
import { announceEntries } from '../voice/speech'
import { loadSettings } from '../settings'

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
 * 只剩一个字符（`G`、`?`、`嗯`）——单字没有上下文，模型只会把原样吐回来。
 * 与 `hasHan` 的分工：hasHan 判「已经是目标语言」，这里判「根本没有可翻的文字」。
 */
export function worthTranslating(body: string): boolean {
  const trimmed = body.replace(/\s+/gu, ' ').trim()
  if (trimmed.length === 0) return false
  if (!/[A-Za-z]/.test(trimmed) && !hasHan(trimmed)) return false
  return [...trimmed].length > 1
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

/**
 * 聊天正文的收口点：Dota 推来的每一行在这里去重、判语言、送翻译、上屏。
 *
 * 抓屏 OCR 整条链路已经移除（Dota 的 `chat_message` 事件给的是同一条消息的
 * 原文，还带玩家与频道，比截图识别准且零延迟）。这个类因此只剩「投递 →
 * 翻译 → 广播」三件事，名字保留是为了不再动调用方。
 */
export class ChatCaptureService {
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
      announceEntries(done)
    }
    if (needs.length === 0) return
    this.translateChain = this.translateChain
      .then(() => this.translatePending(needs.map((entry) => entry.original), needs))
      .catch((err: unknown) => {
        // 队列是一条 Promise 链，一节坏掉会把后面所有翻译冻住且毫无声响。
        this.lastError = `translate chain: ${err instanceof Error ? err.message : String(err)}`
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
      announceEntries(filled)
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err)
    }
  }

  private broadcast(channel: string, entries: CaptureEntry[]): void {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, entries)
    if (channel === IPC.CAPTURE_ENTRIES) {
      for (const callback of this.listeners) callback(entries)
    } else {
      for (const callback of this.updateListeners) callback(entries)
    }
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
        firstError ??= `translate: ${err instanceof Error ? err.message : String(err)}`
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
