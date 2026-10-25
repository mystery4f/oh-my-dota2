import { BrowserWindow } from 'electron'
import { IPC, type CaptureEntry, type SpeakPayload } from '@shared/ipc'
import { loadSettings } from '../settings'
import { heroChinese } from '../hero-names'
import { synthesizeEdge, warmEdge } from './edge'
import { synthesizeOffline } from './offline'

/** 单句上限：再长就不念了——一整段口播会把后面的消息全挤到后面。 */
export const SPEAK_MAX_CHARS = 60

/**
 * 朗读只念正文。`[影魔] [敌方] [敌人B] ⚔ 别送了` 这套装饰是给眼睛看的，
 * 念出来会变成「左方括号影魔右方括号」的噪音，所以开口前把它们全剥掉。
 * 剥完什么都不剩（整行只有装饰）时返回空串，由调用方决定退回原文。
 */
export function speakText(raw: string): string {
  let text = raw.replace(/\s+/g, ' ').trim()
  // 最多剥 8 轮：正常行只有 3–4 段装饰，留点余量防止异常输入死循环。
  for (let round = 0; round < 8; round += 1) {
    const next = text
      // 装饰：[影魔] [敌方] [敌人B] ⚔ / 🌐
      .replace(/^(?:\[[^\]]*\]|⚔\uFE0F?|🌐)\s*/u, '')
      // 说话人前缀（OCR 行 `[All] k1ng: hello` 剥完方括号后长这样）。
      // 只在已经剥过东西之后才动手，免得把正文里自带的「注意：他们来了」也吃掉。
      .replace(round > 0 ? /^[^\s:：]{1,24}[:：]\s+/ : /(?!)/u, '')
    if (next === text) break
    text = next
  }
  return text.trim()
}

/**
 * 长句切段：先前几十个字先出声，剩下的在播放时合成。
 * 为什么不是排版问题：Edge 每段都要一次跨境往返（实测整句 0.7–1.6 s），
 * 一句话 40 个字等一次往返，听众会以为「朗读坏了」。按标点切成 ≤20 字的小段后，
 * 第一段先播，后面的段在播第一段时已经合成完成，听感上是连续的。
 * 只切标点，不动字面：切完拼回来必须和原文一模一样（探针会断言）。
 */
export function splitForSpeech(text: string, maxChars = 20): string[] {
  const raw = text.trim()
  if (!raw) return []
  if (raw.length <= maxChars) return [raw]
  // 标点跟着前一段走，拼回来才不会丢符号。
  const parts = raw.match(/[^，。！？；、,!?;]+[，。！？；、,!?;]?/gu) ?? [raw]
  const pieces: string[] = []
  let current = ''
  for (const part of parts) {
    if (current && current.length + part.length > maxChars) {
      pieces.push(current)
      current = part
    } else {
      current += part
    }
  }
  if (current) pieces.push(current)
  // 极端输入（一句 60 字不带标点）：硬切，宁可断在词中间也不要整句等一次往返。
  const out: string[] = []
  for (const piece of pieces) {
    if (piece.length <= maxChars) {
      out.push(piece)
      continue
    }
    for (let index = 0; index < piece.length; index += maxChars) out.push(piece.slice(index, index + maxChars))
  }
  return out
}

export interface SpeakOptions {
  /** 朗读引擎：edge 用神经语音，system 用系统嗓子。默认 edge。 */
  engine?: 'system' | 'edge' | 'offline'
  readAloud: boolean
  /** 自己发的也念；缺省关闭（见 AppSettings.ttsReadOwn）。 */
  readOwn?: boolean
  rate: number
  /** 音高倍率，1 = 原声；只有 Edge 引擎认这个参数。 */
  pitch: number
  voice: string
}

/**
 * 决定「这一条要不要念」。纯函数，探针直接喂数据断言，不依赖窗口与音频。
 * 返回 null 表示这条不该出声；返回 payload 就是浮层要念的内容。
 */
/** GSI 行前缀里的 [关系]（我/队友/敌方）：英雄名拿不到时退而求其次，至少念出是哪边在说。 */
function relationFromLine(raw: string): string | null {
  const head = raw.split(/[⚔🌐]/u)[0] ?? ''
  const hit = /\[(我|队友|敌方)\]/u.exec(head)
  return hit ? hit[1] : null
}

export function decideSpeak(entry: CaptureEntry, options: SpeakOptions): SpeakPayload | null {
  if (!options.readAloud) return null
  // 还在翻译 / 翻译失败 / 没有译文的，都不念：念出来只是噪音。
  // 自己说的话不念：出声只为了听懂别人；真对局实测（2026-10-25, match 9060903477），
  // 自己那句「::」被念成「司夜刺客说，」、紧接着敌方的 BASE 译文「基地」到达，
  // 两句连听就成了「司夜刺客说基地」——own 正是为这个跳过而存在的字段。
  if (entry.own === true && options.readOwn !== true) return null
  if (entry.pending) return null
  // 念之前先剥掉 `[昵称] ⚔` 这类装饰；剥空了就退回原文正文，别念一串标签。
  const body = speakText(entry.translated ?? '') || speakText(entry.original)
  if (!body) return null
  // 有英雄名就念成「某某 说 ……」：听的人需要知道是谁在说话，但不需要听方括号和频道符号。
  // 「说」不能省：没有它听起来像两个不相干的短语被连读；用逗号接住，
  // 句号会让引擎在「说」后面停一拍，就是用户抱怨的那个卡顿。
  // 有英雄名就念「某某说，」；GSI 只推自己的 hero 块，别人的英雄（allplayers）真对局
  // 实测一帧都没到过——拿不到英雄时退回行前缀里的 [关系]，念「队友说，/敌方说，」，
  // 比光秃秃念内容至少多一层「谁在说话」；OCR 行没有关系标签就老老实实不加前缀。
  const relation = entry.speaker ? null : relationFromLine(entry.original)
  const prefix = entry.speaker
    ? `${heroChinese(entry.speaker)}说，`
    : relation
      ? `${relation}说，`
      : ''
  const text = prefix ? `${prefix}${body}` : body
  const clipped = text.length > SPEAK_MAX_CHARS ? `${text.slice(0, SPEAK_MAX_CHARS)}…` : text
  return {
    text: clipped,
    engine: options.engine ?? 'edge',
    // 中文用中文嗓子，其余用英文嗓子；判据看译文本身，不看用户设置。
    lang: /[\u3400-\u9fff]/.test(clipped) ? 'zh' : 'en',
    rate: Math.min(2, Math.max(0.5, options.rate)),
    pitch: Math.min(1.3, Math.max(0.7, options.pitch)),
    voice: options.voice
  }
}

/** 把本拍新到达的译文交给浮层去念。手动那张照不念——点一下就冒出声会很惊吓。 */
/**
 * 从设置组装 decideSpeak 的入参。engine 必须显式带进来：漏掉时 decideSpeak 会默认
 * edge，离线分支合成出的 WAV 在 deliver 里就被标成 audio/mpeg，浮层按 mp3 解不开。
 */
export function speakOptionsFromSettings(settings: {
  ttsReadAloud: boolean
  ttsReadOwn: boolean
  ttsRate: number
  ttsPitch: number
  ttsVoice: string
  ttsEngine: 'system' | 'edge' | 'offline'
}): SpeakOptions {
  return {
    engine: settings.ttsEngine,
    readAloud: settings.ttsReadAloud,
    readOwn: settings.ttsReadOwn,
    rate: settings.ttsRate,
    pitch: settings.ttsPitch,
    voice: settings.ttsVoice
  }
}
export function announceEntries(entries: CaptureEntry[]): void {
  if (entries.length === 0) return
  const settings = loadSettings()
  if (!settings.ttsReadAloud) return
  const options = speakOptionsFromSettings(settings)
  const engine = settings.ttsEngine
  // 连接池会凉：距离上次朗读超过一分钟就重新握手一次，别让下一句替用户等那 1–21 秒。
  if (engine === 'edge' && Date.now() - lastSpeakAt > 60_000) warmEdge()
  lastSpeakAt = Date.now()
  for (const entry of entries) {
    const payload = decideSpeak(entry, options)
    if (!payload) continue
    // 合成先并行跑，投递仍按顺序：串行合成会让「一句 = 一次网络往返」累加成几秒的延迟，
    // 连发三句就要等三次，听起来就是「反应慢半拍」。
    // 离线引擎在本地推理（实测 81–193 ms），不需要等网络；它同样是「先合成、再按序投递」。
    if (engine === 'offline') {
      speakChain = speakChain
        .then(() => deliver(payload, synthesizeOffline(payload.text, settings.ttsOfflineVoice, payload.rate)))
        .catch(() => undefined)
      continue
    }
    if (engine !== 'edge') {
      speakChain = speakChain.then(() => deliver(payload, null)).catch(() => undefined)
      continue
    }
    // Edge：整句切成小段，各段同时发起合成，再按原顺序投递——第一段先出声。
    const segments = splitForSpeech(payload.text)
    const audios = segments.map((segment) => synthesizeEdge(segment, payload.voice, payload.rate, payload.pitch))
    segments.forEach((segment, index) => {
      const audio = audios[index]
      speakChain = speakChain.then(() => deliver({ ...payload, text: segment }, audio)).catch(() => undefined)
    })
  }
}

let lastSpeakAt = 0

let speakChain: Promise<void> = Promise.resolve()

async function deliver(payload: SpeakPayload, audioPromise: Promise<Buffer | null> | null): Promise<void> {
  let packet = payload
  if (audioPromise) {
    const audio = await audioPromise
    // 合成失败就不带 audio 下发：渲染层对 edge/offline 一律整句跳过，不临时换系统嗓子。
    if (audio) packet = { ...payload, audio: audio.toString('base64'), audioMime: payload.engine === 'offline' ? 'audio/wav' : 'audio/mpeg' }
  }
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.VOICE_SPEAK, packet)
}
