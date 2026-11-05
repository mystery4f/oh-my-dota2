import { BrowserWindow } from 'electron'
import { IPC, type CaptureEntry, type SpeakPayload } from '@shared/ipc'
import { loadSettings } from '../settings'
import { heroChinese } from '../hero-names'
import { warmEdge } from './edge'
import { speakPipeline, type SpeechSegment } from './speech-pipeline'
import { resolveSpeechPlan } from '@shared/speech-plan'
import { DEFAULT_EDGE_VOICE, EDGE_VOICES } from '@shared/tts-voices'

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


export interface SpeakOptions {
  /** 朗读引擎：edge 用神经语音，system 用系统嗓子，sovits 走本机 GPT-SoVITS 服务。默认 edge。 */
  engine?: 'system' | 'edge' | 'offline' | 'sovits'
  /** 离线嗓 id：朗读两条音色槽里离线那一槽，计划值按引擎决定用哪个（声出不传）。 */
  offlineVoice?: string
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
  /** 长句切段上限（字）：edge / sovits 切段用；缺省 30（AppSettings.ttsSpeakSegmentChars）。 */
  segmentChars?: number
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
  // 引擎、嗓音、语言、语速、音高全交给计划值：四条腿同一份判断，改一处四腿一起变。
  const plan = resolveSpeechPlan({
    engine: options.engine,
    voice: options.voice,
    offlineVoice: options.offlineVoice,
    rate: options.rate,
    pitch: options.pitch,
    segmentChars: options.segmentChars,
    text: clipped,
    edgeVoices: EDGE_VOICES,
    defaultEdgeVoice: DEFAULT_EDGE_VOICE
  })
  return {
    // 捕获时间随包走：投递层/浮层拿它判过期（新消息已到就不再念旧的）。
    ts: entry.ts,
    text: clipped,
    engine: plan.engine,
    lang: plan.lang,
    rate: plan.rate,
    pitch: plan.pitch,
    voice: plan.voice
  }
}

/**
 * 本拍译文是否已过期：宣布（announce）时若已有更新的捕获到达，念它只会让朗读越排越落后——
 * 「先念上一条再念当前」就是这么来的。队列与投递两道闸都收进了 speech-pipeline：
 * 它们掐得到还在排队的，掐不掉「刚翻译完、正要宣布」的这一类，所以宣布时点也要拦一道。
 */
export function isAnnounceStale(entryTs: number, cutoff: number | undefined, drop: boolean): boolean {
  return drop === true && cutoff !== undefined && entryTs < cutoff
}
/** 把本拍新到达的译文交给浮层去念。手动那张照不念——点一下就冒出声会很惊吓。
 * cutoff=最新一次捕获的时间戳（capture 层传入）：ttsDropBacklog 开着时，宣布此刻已过期
 * （捕获时间早于更新一拍）的条目直接跳过；宁可漏念旧的，也不让队列越念越落后。 */
/**
 * 从设置组装 decideSpeak 的入参。引擎与音色的选法在计划值里（shared/speech-plan），
 * 这里只做「设置字段 → 入参字段」的搬运，不再承担引擎语义。
 */
export function speakOptionsFromSettings(settings: {
  ttsReadAloud: boolean
  ttsReadOwn: boolean
  ttsRate: number
  ttsPitch: number
  ttsVoice: string
  ttsOfflineVoice?: string
  ttsEngine: 'system' | 'edge' | 'offline' | 'sovits'
  ttsSpeakPrefix: 'front' | 'back' | 'off'
  ttsSpeakSegmentChars?: number
  ttsSpeakFrontTpl: string
  ttsSpeakBackTpl: string
}): SpeakOptions {
  return {
    engine: settings.ttsEngine,
    readAloud: settings.ttsReadAloud,
    readOwn: settings.ttsReadOwn,
    prefix: settings.ttsSpeakPrefix,
    segmentChars: settings.ttsSpeakSegmentChars ?? 30,
    frontTpl: settings.ttsSpeakFrontTpl,
    backTpl: settings.ttsSpeakBackTpl,
    rate: settings.ttsRate,
    pitch: settings.ttsPitch,
    voice: settings.ttsVoice,
    offlineVoice: settings.ttsOfflineVoice
  }
}
export function announceEntries(entries: CaptureEntry[], cutoff?: number): void {
  // 截止线随每句进管线记账（speech-pipeline 里的 latestCaptureAt）：投递闸靠它拦合成期间变旧的。
  const settings = loadSettings()
  if (!settings.ttsReadAloud) return
  const options = speakOptionsFromSettings(settings)
  const engine = settings.ttsEngine
  // 连接池会凉：距离上次朗读超过一分钟就重新握手一次，别让下一句替用户等那 1–21 秒。
  if (engine === 'edge' && Date.now() - lastSpeakAt > 60_000) warmEdge()
  lastSpeakAt = Date.now()
  for (const entry of entries) {
    const payload = decideSpeak(entry, options)
    if (isAnnounceStale(entry.ts, cutoff, settings.ttsDropBacklog === true)) {
      // 静默路径留痕：宣布时已被更新一拍顶掉——念它只会把队伍排反。
      console.log('TTS_SPEAK_DROP', JSON.stringify({ stage: 'announce', text: entry.original.slice(0, 30) }))
      continue
    }
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
    // 一句交给管线：切段、并行合成、按序投递、丢弃与失败策略全在管内（见 speech-pipeline）。
    // lane='announce' 保证同一拍多条、跨拍多条都按到达顺序出声；GV 的懒队列由管线自带。
    void speakPipeline(
      {
        text: payload.text,
        engine,
        ts: payload.ts,
        cutoff,
        dropStale: settings.ttsDropBacklog === true,
        split: true,
        segmentChars: options.segmentChars,
        voice: payload.voice,
        rate: payload.rate,
        pitch: payload.pitch,
        lang: payload.lang,
        lane: 'announce'
      },
      (segment) => broadcast(payload, segment)
    ).catch(() => undefined)
  }
}

let lastSpeakAt = 0

/** 把管线产出的一段交给浮层发声。system 引擎不带音频（浮层用系统嗓子念）；
 * 其余引擎合成失败就不下发——浮层对 edge/offline/sovits 一律整句跳过，绝不临时换系统嗓子。 */
function broadcast(payload: SpeakPayload, segment: SpeechSegment): void {
  const packet: SpeakPayload =
    segment.audio && segment.audioMime
      ? { ...payload, text: segment.text, audio: segment.audio.toString('base64'), audioMime: segment.audioMime }
      : { ...payload, text: segment.text }
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(IPC.VOICE_SPEAK, packet)
}
