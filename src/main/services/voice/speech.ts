import { BrowserWindow } from 'electron'
import { IPC, type CaptureEntry, type SpeakPayload } from '@shared/ipc'
import { loadSettings } from '../settings'
import { heroChinese } from '../hero-names'
import { synthesizeEdge, warmEdge } from './edge'
import { synthesizeOffline } from './offline'
import { synthesizeSovits } from './sovits'

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
  /** 朗读引擎：edge 用神经语音，system 用系统嗓子，sovits 走本机 GPT-SoVITS 服务。默认 edge。 */
  engine?: 'system' | 'edge' | 'offline' | 'sovits'
  readAloud: boolean
  /** 自己发的也念；缺省关闭（见 AppSettings.ttsReadOwn）。 */
  readOwn?: boolean
  rate: number
  /** 「某某说」念在哪头：front 句首（缺省）/ back 句尾 / off 不念。 */
  prefix?: 'front' | 'back' | 'off'
  /** 句首模板，{who}=说话人、{body}=内容；不给走缺省「{who}说，{body}」。 */
  frontTpl?: string
  /** 句尾模板，不给走缺省「{body}，{who}表示」。标点措辞全由模板说了算。 */
  backTpl?: string
  /** 音高倍率，1 = 原声；只有 Edge 引擎认这个参数。 */
  pitch: number
  voice: string
}

/**
 * 决定「这一条要不要念」。纯函数，探针直接喂数据断言，不依赖窗口与音频。
 * 返回 null 表示这条不该出声；返回 payload 就是浮层要念的内容。
 */
/**
 * 这条为什么不念。decideSpeak 只答 null，排查「怎么没出声」时五种静默路径在界面上长得
 * 一样——own/pending/empty 谁拦的要能从日志直接读出来，所以把判据单独抽成纯函数。
 */
export function speakSkipReason(entry: CaptureEntry, options: SpeakOptions): 'mute' | 'own' | 'pending' | 'empty' | null {
  if (!options.readAloud) return 'mute'
  // 自己说的话不念：出声只为了听懂别人；真对局实测（2026-10-25, match 9060903477），
  // 自己那句「::」被念成「司夜刺客说，」、紧接着敌方的 BASE 译文「基地」到达，
  // 两句连听就成了「司夜刺客说基地」——own 正是为这个跳过而存在的字段。
  if (entry.own === true && options.readOwn !== true) return 'own'
  // 还在翻译 / 翻译失败 / 没有译文的，都不念：念出来只是噪音。
  if (entry.pending) return 'pending'
  if (!speakText(entry.translated ?? '') && !speakText(entry.original)) return 'empty'
  return null
}

/** GSI 行前缀里的说话人标签：[我/队友/敌方/玩家] 后面那个 [昵称/玩家N]。「玩家」是阵营未知时的兜底关系（allplayers 不来、频道又判不出敌我），漏了它所有人频道全退成裸念。 */
function speakerFromLine(raw: string): string | null {
  const head = raw.split(/[⚔🌐]/u)[0] ?? ''
  const hit = /\[(?:我|队友|敌方|玩家)\]\s*\[([^\]]+)\]/u.exec(head)
  const label = hit?.[1]?.trim()
  // slotLabel 兜底出「未知」时，念「未知说」比不念还难受，退空让内容裸念。
  return label && label !== '未知' ? label : null
}
export function decideSpeak(entry: CaptureEntry, options: SpeakOptions): SpeakPayload | null {
  if (speakSkipReason(entry, options) !== null) return null
  // 念之前先剥掉 `[昵称] ⚔` 这类装饰；剥空了就退回原文正文，别念一串标签。
  const body = speakText(entry.translated ?? '') || speakText(entry.original)
  // 有英雄名就念成「某某 说 ……」：听的人需要知道是谁在说话，但不需要听方括号和频道符号。
  // 「说」不能省：没有它听起来像两个不相干的短语被连读；用逗号接住，
  // 句号会让引擎在「说」后面停一拍，就是用户抱怨的那个卡顿。
  // 前缀规则（2026-10-25 用户定稿）：自己的话念「我说，」（开了「自己也念」才走到这）；
  // 别人有英雄念「英雄说，」（GSI 只推自己的 hero 块，allplayers 真对局一帧都没到过）；
  // 别人没英雄念行前缀里的座位标签「玩家2说，」，比笼统的「队友说」对得上屏幕上是谁在讲话；
  // 手动/快照行没有标签就老老实实不加前缀。
  // 「某某说」的位置（ttsSpeakPrefix）：front=句首「影魔说，中路没人」（缺省）；
  // 说话人怎么念由模板全权决定（含标点）：{who}=我/影魔/玩家9，{body}=内容。
  // 缺省 front「{who}说，{body}」back「{body}，{who}表示」；没配 {body} 的模板在
  // loadSettings 就被打回缺省，这里只兜底空值。off 与「没有标签」走同一条路径。
  const candidate = entry.own === true
    ? '我'
    : entry.speaker
      ? heroChinese(entry.speaker)
      : speakerFromLine(entry.original)
  const pos = options.prefix ?? 'front'
  const spoken = pos === 'off' ? null : candidate
  const tpl =
    pos === 'back'
      ? options.backTpl || '{body}，{who}表示'
      : options.frontTpl || '{who}说，{body}'
  const text = spoken ? tpl.replace('{who}', spoken).replace('{body}', body) : body
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
  ttsEngine: 'system' | 'edge' | 'offline' | 'sovits'
  ttsSpeakPrefix: 'front' | 'back' | 'off'
  ttsSpeakFrontTpl: string
  ttsSpeakBackTpl: string
}): SpeakOptions {
  return {
    engine: settings.ttsEngine,
    readAloud: settings.ttsReadAloud,
    readOwn: settings.ttsReadOwn,
    prefix: settings.ttsSpeakPrefix,
    frontTpl: settings.ttsSpeakFrontTpl,
    backTpl: settings.ttsSpeakBackTpl,
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
    if (!payload) {
      // 静默路径留痕：own / pending / 空正文三种跳过在浮层上都一样（没声音），
      // 没有 TTS_SPEAK_SKIP 的话「怎么没念」只能靠翻代码猜。
      console.log(
        'TTS_SPEAK_SKIP',
        JSON.stringify({ reason: speakSkipReason(entry, options), own: entry.own === true, text: entry.original.slice(0, 30) })
      )
      continue
    }
    // 前缀来源留痕：speaker=英雄名（现实中只有自己的话有）；fallback=退回的座位标签；
    // 两者皆空=光念内容。英雄名消失这类问题，有这条日志就不用考古了。
    console.log(
      'TTS_SPEAK_PICK',
      JSON.stringify({
        engine: payload.engine,
        speaker: entry.speaker ?? null,
        fallback: entry.speaker ? null : speakerFromLine(entry.original),
        text: payload.text.slice(0, 40)
      })
    )
    // 合成先并行跑，投递仍按顺序：串行合成会让「一句 = 一次网络往返」累加成几秒的延迟，
    // 连发三句就要等三次，听起来就是「反应慢半拍」。
    // 离线引擎在本地推理（实测 81–193 ms），不需要等网络；它同样是「先合成、再按序投递」。
    if (engine === 'offline') {
      speakChain = speakChain
        .then(() => deliver(payload, synthesizeOffline(payload.text, settings.ttsOfflineVoice, payload.rate)))
        .catch(() => undefined)
      continue
    }
    // GPT-SoVITS：本机 api_v2，音色由参考音频决定。与 Edge 同样切段并行、按序投递；
    // 服务不在 / 参考没配，合成得 null，浮层整句跳过——绝不回退系统嗓子。
    // GPT-SoVITS：本机 api_v2，音色由参考音频决定。走专用队列（见 enqueueSovitsSpeak）：
    // 一次只合成一条、可丢弃积压——预发全部请求会让本机显卡被服务端排队按死。
    // 服务不在 / 参考没配，合成得 null，浮层整句跳过——绝不回退系统嗓子。
    if (engine === 'sovits') {
      enqueueSovitsSpeak(payload, settings.ttsDropBacklog === true)
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

/**
 * GPT-SoVITS 专用朗读队列。与 Edge 不同，sovits 在本机显卡上推理（游戏吃着显卡时一句
 * 2–7 s），「进队列就把所有段的合成请求都发出去」会让 api_v2 服务端堆一串排不完的活，
 * 显卡被按住几十秒——游戏掉帧，读到的还是过时消息。这里改成：
 * - 合成懒启动：轮到谁才合成谁，同一时刻服务端最多积一段（段间预取保连续）；
 * - 「丢弃积压」开启时，新消息一来就顶掉整条队列，被顶掉的永不合成（TTS_SPEAK_DROP）；
 *   消息放到一半来了新的，剩下的段也当场作废。
 */
interface SovitsJob {
  payload: SpeakPayload
  segments: string[]
  gen: number
}

/** 丢弃积压（纯函数，探针断言）：开关开着且队里已有待读消息时，队列只保留新来的这条。 */
export function applyBacklogPolicy<T>(queue: T[], drop: boolean, incoming: T): { queue: T[]; dropped: T[] } {
  if (!drop || queue.length === 0) return { queue: [...queue, incoming], dropped: [] }
  return { queue: [incoming], dropped: [...queue] }
}

/** 这条是否已被更新的消息顶掉（纯函数）：只在「丢弃积压」开启时才淘汰旧代。 */
export const isSpeakStale = (drop: boolean, jobGen: number, currentGen: number): boolean => drop && jobGen !== currentGen

const sovitsQueue: SovitsJob[] = []
let sovitsGen = 0
let sovitsPumping = false

function enqueueSovitsSpeak(payload: SpeakPayload, drop: boolean): void {
  const plan = applyBacklogPolicy(sovitsQueue, drop, {
    payload,
    segments: splitForSpeech(payload.text),
    gen: sovitsGen + 1
  })
  sovitsGen += 1
  sovitsQueue.length = 0
  sovitsQueue.push(...plan.queue)
  if (plan.dropped.length > 0) {
    console.log('TTS_SPEAK_DROP', JSON.stringify({ stage: 'queued', dropped: plan.dropped.length, keep: payload.text.slice(0, 30) }))
  }
  void pumpSovits(drop)
}

async function pumpSovits(drop: boolean): Promise<void> {
  if (sovitsPumping) return
  sovitsPumping = true
  try {
    while (sovitsQueue.length > 0) {
      const job = sovitsQueue.shift()!
      // 预取下一段：当前段在浮层播放时下一段已在合成，长句听完不出空窗。
      let prefetch: Promise<Buffer | null> | null = null
      for (let index = 0; index < job.segments.length; index += 1) {
        if (isSpeakStale(drop, job.gen, sovitsGen)) {
          console.log('TTS_SPEAK_DROP', JSON.stringify({ stage: 'stale', text: job.segments[index].slice(0, 20) }))
          break
        }
        const audio = prefetch ?? (await synthesizeSovits(job.segments[index], job.payload.rate, job.payload.lang))
        prefetch = null
        // 合成期间来了新消息：这条剩下的段不再投递（音频已花掉，认了）。
        if (isSpeakStale(drop, job.gen, sovitsGen)) {
          console.log('TTS_SPEAK_DROP', JSON.stringify({ stage: 'synthesized', text: job.segments[index].slice(0, 20) }))
          break
        }
        prefetch =
          index + 1 < job.segments.length
            ? synthesizeSovits(job.segments[index + 1], job.payload.rate, job.payload.lang)
            : null
        await deliver({ ...job.payload, text: job.segments[index] }, audio ? Promise.resolve(audio) : null)
      }
    }
  } finally {
    sovitsPumping = false
  }
}

async function deliver(payload: SpeakPayload, audioPromise: Promise<Buffer | null> | null): Promise<void> {
  let packet = payload
  if (audioPromise) {
    const audio = await audioPromise
    // 合成失败就不带 audio 下发：渲染层对 edge/offline/sovits 一律整句跳过，不临时换系统嗓子。
    if (audio) packet = { ...payload, audio: audio.toString('base64'), audioMime: payload.engine === 'offline' || payload.engine === 'sovits' ? 'audio/wav' : 'audio/mpeg' }
  }
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.VOICE_SPEAK, packet)
}
