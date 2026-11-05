import type { OfflineVoiceId } from '@shared/ipc'
import type { TtsVoiceOption } from '@shared/tts-voices'
import { synthesizeEdge } from './edge'
import { synthesizeOffline } from './offline'
import { synthesizeSovits } from './sovits'
import { SPEECH_MIME, speechLang, type SpeechMime } from '@shared/speech-plan'
import type { SpeechEngine } from '@shared/speech-plan'

/**
 * 合成管线：把一句文本变成按序音频段的公共机器——切段、按引擎并发策略合成、
 * 按序产出、丢弃积压、合成失败不回退系统嗓子。朗读（speech.ts）、声出（voice-out.ts）、
 * 试听（tts.ts）都从这里走，同一套规则只写一遍。
 * 引擎适配器是一条缝：探针注入假引擎锁时序行为，生产用 realSpeechSynthAdapters。
 * @author dongcheng.xie
 */


/** 引擎适配器缝：探针注入假引擎；生产实现就是三个真实合成器（全部失败返回 null，不抛错）。 */
export interface SpeechSynthAdapters {
  edge(text: string, voice: string, rate: number, pitch: number, allowedVoices?: readonly TtsVoiceOption[]): Promise<Buffer | null>
  offline(text: string, voice: string, rate: number): Promise<Buffer | null>
  sovits(text: string, rate: number, lang: 'zh' | 'en'): Promise<Buffer | null>
}

export const realSpeechSynthAdapters: SpeechSynthAdapters = {
  edge: (text, voice, rate, pitch, allowedVoices) => synthesizeEdge(text, voice, rate, pitch, allowedVoices),
  offline: (text, voice, rate) => synthesizeOffline(text, voice as OfflineVoiceId, rate),
  sovits: (text, rate, lang) => synthesizeSovits(text, rate, lang)
}

/** 长句切段：先前几十个字先出声，剩下的在播放时合成。
 * 为什么不是排版问题：Edge 每段都要一次跨境往返（实测整句 0.7–1.6 s），
 * 一句话 40 个字等一次往返，听众会以为「朗读坏了」。按标点切成小段后（上限面板可配，默认 30），
 * 只切标点，不动字面：切完拼回来必须和原文一模一样（探针会断言）。 */
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

export interface SpeechRequest {
  /** 要念的整句（说话人前缀等装饰由调用方拼好；切段在管线内做）。 */
  text: string
  engine: SpeechEngine
  /** 捕获时间戳：丢弃积压开着时，投递闸拿它对照过期基准。 */
  ts?: number
  /** 本拍最新捕获时间：推进管线内的过期基准（单调取大）。 */
  cutoff?: number
  /** 丢弃积压：本条排队时被更新的顶掉、播到一半被顶掉、或投递时已过期，都直接作废。 */
  dropStale?: boolean
  /** 切段开关：仅 edge/sovits 生效（offline 本地推理整句够快，system 单段伪合成）。 */
  split?: boolean
  /** 切段上限（字），缺省 30。 */
  segmentChars?: number
  /** edge 嗓音。 */
  voice?: string
  /** edge 允许的嗓音白名单：朗读走默认中文嗓清单，声出传 VOICE_OUT_VOICES 放英文嗓进来。 */
  edgeVoices?: readonly TtsVoiceOption[]
  rate: number
  /** 音高倍率，仅 edge 认。 */
  pitch?: number
  /** 合成语言，仅 sovits 认；缺省按段文本判（含 CJK 即中文）。 */
  lang?: 'zh' | 'en'
  /** 每段精调：声出按段解析嗓/语言（英文占位）；返回字段缺省回落到请求级。 */
  resolveSegment?: (segment: string) => { voice?: string; lang?: 'zh' | 'en' }
  /** 探针注入假引擎；生产不传。 */
  adapters?: Partial<SpeechSynthAdapters>
  /** 投递通道：同通道的单子按序投递（朗读每拍一批，靠它保证跨批有序；声出/试听单发不传）。 */
  lane?: string
}

/** 一次合成调用：引擎差异只在参数怎么给，调用处不看引擎名。 */
type SynthCall = (
  adapters: SpeechSynthAdapters,
  text: string,
  voice: string,
  request: SpeechRequest
) => Promise<Buffer | null>

export interface EngineDriver {
  /** 切段：长句按标点切段（edge 分散跨境往返、sovits 分散等待）；整句够快的引擎不切。 */
  split: boolean
  /** 出什么格式：system 不出音频（null），其余二选一。 */
  mime: SpeechMime | null
  /** 合成时机：入队就发车 / 轮到才合成 / 本机排队懒启动 / 不出音频。 */
  scheduling: 'eager' | 'lazy' | 'sovits' | 'none'
  /** 入队即发车的引擎（eager）：往返时间藏进投递顺位里。 */
  atEnqueue?: SynthCall
  /** 轮到才合成的引擎（lazy）：过期单子根本不浪费推理。 */
  atDelivery?: SynthCall
}

/**
 * 引擎表：一个引擎一行，差异只有这几项。加引擎＝表里加一行——
 * 若发现按引擎名写的 if 出现在两处以上，说明这个差异没进表。
 * sovits 的合成在 pumpSovits（预取 + 换代作废在同一处），表里只声明切段与排队方式。
 */
const ENGINE_DRIVERS: Record<SpeechEngine, EngineDriver> = {
  system: { split: false, mime: null, scheduling: 'none' },
  edge: {
    split: true,
    mime: SPEECH_MIME.edge,
    scheduling: 'eager',
    atEnqueue: (adapters, text, voice, request) =>
      adapters.edge(text, voice, request.rate, request.pitch ?? 1, request.edgeVoices)
  },
  offline: {
    split: false,
    mime: SPEECH_MIME.offline,
    scheduling: 'lazy',
    atDelivery: (adapters, text, voice, request) => adapters.offline(text, voice, request.rate)
  },
  sovits: { split: true, mime: SPEECH_MIME.sovits, scheduling: 'sovits' }
}

/** 管线产出的一段：audio 为 null 时——system 是交给渲染层系统嗓子，其余引擎是合成失败（调用方跳过这句，绝不换系统嗓子）。 */
export interface SpeechSegment {
  index: number
  text: string
  audio: Buffer | null
  audioMime: 'audio/mpeg' | 'audio/wav' | null
}

export interface SpeechOutcome {
  /** 按序交到 onSegment 的段数（含 system 伪合成段）。 */
  delivered: number
  /** 因丢弃积压作废的段数（排队被顶掉/中途过期/投递时已过期）。 */
  dropped: number
  /** 非系统引擎下整句没合成出任何音频且没被丢弃：调用方按「这句不念」处理。 */
  synthFailed: boolean
}

/** 丢弃积压（纯函数，探针断言）：开关开着且队里已有待读消息时，队里可丢的只留新来的这条；
 * isDroppable 用来豁免不许丢的单子（如声出的整句回复）。 */
export function applyBacklogPolicy<T>(
  queue: T[],
  drop: boolean,
  incoming: T,
  isDroppable: (item: T) => boolean = () => true
): { queue: T[]; dropped: T[] } {
  if (!drop || queue.length === 0) return { queue: [...queue, incoming], dropped: [] }
  const droppable = queue.filter(isDroppable)
  const kept = queue.filter((item) => !isDroppable(item))
  return { queue: [...kept, incoming], dropped: droppable }
}

/** 这条是否已被更新的消息顶掉（纯函数）：只在「丢弃积压」开启时才淘汰旧代。 */
export const isSpeakStale = (drop: boolean, jobGen: number, currentGen: number): boolean => drop && jobGen !== currentGen

/** 投递闸（纯函数）：合成这几秒里来了更新的捕获，旧的不再投。 */
export const isDeliverStale = (drop: boolean, ts: number | undefined, base: number): boolean =>
  drop && ts !== undefined && ts < base


function resolveFor(
  request: SpeechRequest,
  segment: string
): { voice: string; lang: 'zh' | 'en' } {
  const refined = request.resolveSegment?.(segment)
  return {
    voice: refined?.voice ?? request.voice ?? '',
    lang: refined?.lang ?? request.lang ?? speechLang(segment)
  }
}

/** 切段计划：split 只对 edge/sovits 生效；offline/system 永远整句一段。 */
function planSegments(request: SpeechRequest): string[] {
  if (!ENGINE_DRIVERS[request.engine].split) return [request.text]
  return request.split === true ? splitForSpeech(request.text, request.segmentChars ?? 30) : [request.text]
}

function logDrop(stage: string, text: string, extra: Record<string, unknown> = {}): void {
  console.log('TTS_SPEAK_DROP', JSON.stringify({ stage, text: text.slice(0, 30), ...extra }))
}

/** 最新一次捕获的时间戳：投递闸对照它——合成这几秒里来了更新的消息，旧的就不投了。 */
let latestCaptureAt = 0

/** edge 的切段合成在入队时立刻全部发车——网络往返时间藏进投递顺位里；offline 到点现合成；system 无合成。 */
/** 入队即发车：所有段的合成请求在排队时就全部发出去，往返时间藏进投递顺位里。 */
function startEagerSynths(
  call: SynthCall,
  request: SpeechRequest,
  adapters: SpeechSynthAdapters,
  segments: string[]
): Promise<Buffer | null>[] {
  return segments.map((segment) => call(adapters, segment, resolveFor(request, segment).voice, request))
}

/** 投递一段产出：按序 await、投递闸拦截、失败留 null——调用方整句跳过，绝不换系统嗓子。 */
async function deliverSegments(
  request: SpeechRequest,
  adapters: SpeechSynthAdapters,
  segments: string[],
  eager: Promise<Buffer | null>[] | null,
  onSegment?: (segment: SpeechSegment) => void | Promise<void>
): Promise<SpeechOutcome> {
  let delivered = 0
  let dropped = 0
  let synthOkAny = false
  for (let index = 0; index < segments.length; index += 1) {
    const text = segments[index]
    // 投递时点再拦一道：宣布时只拦了宣布就过期的，这里拦合成期间变旧的。
    if (isDeliverStale(request.dropStale === true, request.ts, latestCaptureAt)) {
      dropped += 1
      logDrop('deliver', text)
      continue
    }
    let audio: Buffer | null = null
    let audioMime: 'audio/mpeg' | 'audio/wav' | null = null
    const driver = ENGINE_DRIVERS[request.engine]
    if (driver.scheduling === 'eager') {
      const pending = eager?.[index]
      if (pending) {
        audio = await pending
        audioMime = audio ? driver.mime : null
      }
    } else if (driver.atDelivery) {
      // 到点现合成：本地推理在投递顺位上跑，过期单子根本不浪费推理。
      audio = await driver.atDelivery(adapters, text, resolveFor(request, text).voice, request)
      audioMime = audio ? driver.mime : null
    }
    if (audio) synthOkAny = true
    delivered += 1
    if (onSegment) await onSegment({ index, text, audio, audioMime })
  }
  return {
    delivered,
    dropped,
    synthFailed: segments.length > 0 && !synthOkAny && dropped === 0 && request.engine !== 'system'
  }
}

/** 投递通道：同通道的单子按序投递，合成已在入队时发完、不被前一句的合成拖住。
 * 朗读每拍一批都进同一条通道保证跨批有序；声出/试听是单发调用，不传 lane 走内联投递。 */
interface LaneJob {
  request: SpeechRequest
  adapters: SpeechSynthAdapters
  segments: string[]
  eager: Promise<Buffer | null>[] | null
  onSegment?: (segment: SpeechSegment) => void | Promise<void>
  resolve: (outcome: SpeechOutcome) => void
}

const lanes = new Map<string, LaneJob[]>()
const lanePumping = new Set<string>()

function enqueueLane(
  key: string,
  request: SpeechRequest,
  adapters: SpeechSynthAdapters,
  onSegment?: (segment: SpeechSegment) => void | Promise<void>
): Promise<SpeechOutcome> {
  return new Promise((resolve) => {
    const segments = planSegments(request)
    const drive = ENGINE_DRIVERS[request.engine]
    const eager = drive.atEnqueue ? startEagerSynths(drive.atEnqueue, request, adapters, segments) : null
    const lane = lanes.get(key) ?? []
    lanes.set(key, [...lane, { request, adapters, segments, eager, onSegment, resolve }])
    void pumpLane(key)
  })
}

async function pumpLane(key: string): Promise<void> {
  if (lanePumping.has(key)) return
  lanePumping.add(key)
  try {
    for (let job = lanes.get(key)?.shift(); job; job = lanes.get(key)?.shift()) {
      job.resolve(await deliverSegments(job.request, job.adapters, job.segments, job.eager, job.onSegment))
    }
  } finally {
    lanePumping.delete(key)
  }
}

/** 合成→按序投递的唯一入口。失败不抛、不回退；system 引擎整段交渲染层系统嗓子。 */
export async function speakPipeline(
  request: SpeechRequest,
  onSegment?: (segment: SpeechSegment) => void | Promise<void>
): Promise<SpeechOutcome> {
  const adapters = { ...realSpeechSynthAdapters, ...request.adapters }
  // 截止线只前进不后退：新的一拍把更旧的候选全部作废。
  if (request.cutoff !== undefined && request.cutoff > latestCaptureAt) latestCaptureAt = request.cutoff
  const driver = ENGINE_DRIVERS[request.engine]
  if (driver.scheduling === 'sovits') return enqueueSovits(request, adapters, onSegment)
  if (request.lane) return enqueueLane(request.lane, request, adapters, onSegment)
  const segments = planSegments(request)
  return deliverSegments(
    request,
    adapters,
    segments,
    driver.atEnqueue ? startEagerSynths(driver.atEnqueue, request, adapters, segments) : null,
    onSegment
  )
}

/**
 * GPT-SoVITS 专用朗读队列。与 Edge 不同，sovits 在本机显卡上推理（游戏吃着显卡时一句
 * 2–7 s），「进队列就把所有段的合成请求都发出去」会让 api_v2 服务端堆一串排不完的活，
 * 显卡被按住几十秒——游戏掉帧，读到的还是过时消息。这里改成：
 * - 合成懒启动：轮到谁才合成谁，同一时刻服务端最多积一段（段间预取保连续）；
 * - 「丢弃积压」开启时，新消息一来就顶掉队列里可丢的旧单，被顶掉的永不合成；
 *   消息放到一半来了新的，剩下的段也当场作废。声出的整句回复不许丢（isDroppable 豁免）。
 */
interface SovitsLaneJob {
  request: SpeechRequest
  adapters: SpeechSynthAdapters
  segments: string[]
  gen: number
  drop: boolean
  onSegment?: (segment: SpeechSegment) => void | Promise<void>
  resolve: (outcome: SpeechOutcome) => void
}

const sovitsLane: SovitsLaneJob[] = []
let sovitsGen = 0
let sovitsPumping = false

function enqueueSovits(
  request: SpeechRequest,
  adapters: SpeechSynthAdapters,
  onSegment?: (segment: SpeechSegment) => void | Promise<void>
): Promise<SpeechOutcome> {
  return new Promise((resolve) => {
    const segments = planSegments(request)
    const plan = applyBacklogPolicy(
      sovitsLane,
      request.dropStale === true,
      { request, adapters, segments, gen: sovitsGen + 1, drop: request.dropStale === true, onSegment, resolve },
      (job) => job.drop
    )
    sovitsGen += 1
    sovitsLane.length = 0
    sovitsLane.push(...plan.queue)
    if (plan.dropped.length > 0) {
      // 被顶掉的单子永不合成：当场按「全部作废」结账，调用方不等一场空。
      for (const job of plan.dropped) job.resolve({ delivered: 0, dropped: job.segments.length, synthFailed: false })
      logDrop('queued', request.text, { dropped: plan.dropped.length })
    }
    void pumpSovits()
  })
}

async function pumpSovits(): Promise<void> {
  if (sovitsPumping) return
  sovitsPumping = true
  try {
    while (sovitsLane.length > 0) {
      const job = sovitsLane.shift()!
      const stale = (): boolean => isSpeakStale(job.drop, job.gen, sovitsGen)
      let delivered = 0
      let dropped = 0
      let synthOkAny = false
      // 预取下一段：当前段在播放时下一段已在合成，长句听完不出空窗。
      let prefetch: Promise<Buffer | null> | null = null
      for (let index = 0; index < job.segments.length; index += 1) {
        const text = job.segments[index]
        if (stale()) {
          logDrop('stale', text)
          dropped += job.segments.length - index
          break
        }
        const resolved = resolveFor(job.request, text)
        const audio = prefetch ? await prefetch : await job.adapters.sovits(text, job.request.rate, resolved.lang)
        prefetch = null
        // 合成期间来了新消息：这条剩下的段不再投递（音频已花掉，认了）。
        if (stale()) {
          logDrop('synthesized', text)
          dropped += job.segments.length - index
          break
        }
        prefetch =
          index + 1 < job.segments.length
            ? job.adapters.sovits(job.segments[index + 1], job.request.rate, resolveFor(job.request, job.segments[index + 1]).lang)
            : null
        // 投递时点再拦一道：宣布时只拦了宣布就过期的，这里拦合成期间变旧的。
        if (isDeliverStale(job.drop, job.request.ts, latestCaptureAt)) {
          logDrop('deliver', text)
          dropped += job.segments.length - index
          break
        }
        if (audio) synthOkAny = true
        delivered += 1
        if (job.onSegment) await job.onSegment({ index, text, audio, audioMime: audio ? 'audio/wav' : null })
      }
      job.resolve({ delivered, dropped, synthFailed: job.segments.length > 0 && !synthOkAny && dropped === 0 })
    }
  } finally {
    sovitsPumping = false
  }
}
