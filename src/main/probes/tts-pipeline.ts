import { exitProbe, guardProbe, probeStep } from './harness'
import { SEGMENT_CHARS_MIN, splitForSpeech } from '@shared/speech-split'
import {
  applyBacklogPolicy,
  isSpeakStale,
  speakPipeline,
  type SpeechRequest,
  type SpeechSegment,
  type SpeechSynthAdapters
} from '../services/voice/speech-pipeline'
import { OFFLINE_VOICES } from '@shared/ipc'
import { resolveSpeechPlan, speechFailHint } from '@shared/speech-plan'
import { DEFAULT_EDGE_VOICE, EDGE_VOICES } from '@shared/tts-voices'

/**
 * `--tts-pipeline-probe`：合成→按序投递管线的全量行为锁（假引擎注入，零网络零显卡零窗口）。
 * 锁的是文出三条腿（朗读/声出/试听）共用的机制：切段并行+按序产出、GV 懒队列
 * （积压丢弃/段间预取/中途作废）、投递闸两道拦截、「合成失败整句跳过，绝不回退系统嗓子」。
 * 引擎本体行为（真合成质量、浮层播放、声出按键）由各自探针与真机验收覆盖。
 */

interface Row {
  name: string
  ok: boolean
  detail: string
}

const cases: Row[] = []
const push = (name: string, ok: boolean, detail: string): void => {
  cases.push({ name, ok, detail })
}

/** 让某个合成调用挂起、由测试控制何时出结果的闸门。 */
function gate(): { promise: Promise<Buffer | null>; open: (audio: Buffer | null) => void } {
  let open!: (audio: Buffer | null) => void
  const promise = new Promise<Buffer | null>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

const wav = (text: string): Buffer => Buffer.from(`wav:${text}`)
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** 假引擎仓：每个调用留痕，edge/sovits 的每次合成挂一道可手动打开的闸。 */
function makeFake(): {
  adapters: SpeechSynthAdapters
  calls: string[]
  gates: Map<string, { promise: Promise<Buffer | null>; open: (audio: Buffer | null) => void }>
} {
  const calls: string[] = []
  const gates = new Map<string, { promise: Promise<Buffer | null>; open: (audio: Buffer | null) => void }>()
  const adapters: SpeechSynthAdapters = {
    edge: (text) => {
      calls.push(`edge:${text}`)
      const g = gate()
      gates.set(`edge:${text}`, g)
      return g.promise
    },
    offline: async (text) => {
      calls.push(`offline:${text}`)
      return wav(text)
    },
    sovits: (text) => {
      calls.push(`sovits:${text}`)
      const g = gate()
      gates.set(`sovits:${text}`, g)
      return g.promise
    }
  }
  return { adapters, calls, gates }
}

const base = (engine: SpeechRequest['engine'], text: string, extra: Partial<SpeechRequest> = {}): SpeechRequest => ({
  text,
  engine,
  rate: 1,
  ...extra
})

/**
 * 段文本**由切段器现算**（#158）：`segmentChars: SEGMENT_CHARS_MIN` 在 #85 之后被钳到 10，
 * 于是 `SEG_TEXT` 整句一段、`gates.get(`edge:${SEGMENTS[0]}`)` 拿到 undefined，
 * `undefined.open()` 抛在 async 里——零输出、超时，看着像环境卡死。
 */
const SEG_TEXT = '甲一二三四五六七八，乙一二三四五六七八，丙一二三四五六七八'
const SEGMENTS = splitForSpeech(SEG_TEXT, SEGMENT_CHARS_MIN, 'punctuation')

/** 取闸门；取不到就说清「想等哪个、现在有哪些」。 */
function gateFor(
  gates: Map<string, { promise: Promise<Buffer | null>; open: (audio: Buffer | null) => void }>,
  key: string
): { promise: Promise<Buffer | null>; open: (audio: Buffer | null) => void } {
  const hit = gates.get(key)
  if (hit === undefined) throw new Error(`闸门没等到：expected ${key}，现在有 ${[...gates.keys()].join('|')}`)
  return hit
}

export async function runTtsPipelineProbe(): Promise<void> {
  // #158：看住这条可能永远不返回的探针；到点写 SKIP 并 exit 0，不许挂死 CI。
  guardProbe('TTS_PIPELINE_PROBE')
  probeStep('切段：标点切、拼回来一字不差')
  // —— 切段：标点切、拼回来一字不差 ——
  const line = '小心中路，他们可能在打肉山，别送！'
  const segs = splitForSpeech(line, 10)
  push('切段：拼回来与原文一致', segs.join('') === line, JSON.stringify(segs))
  push('切段：无标点长句硬切（上限被钳到 10，12 字切成 10+2）', JSON.stringify(splitForSpeech('甲乙丙丁戊己庚辛壬癸子丑', 4)) === JSON.stringify(['甲乙丙丁戊己庚辛壬癸', '子丑']), splitForSpeech('甲乙丙丁戊己庚辛壬癸子丑', 4).join('|'))

  // —— 丢弃积压 / 代际（纯函数，与 tts-play 探针各锁一遍）——
  const backlog = applyBacklogPolicy(['旧一', '旧二'], true, '新的')
  push('丢弃积压：队列只留新单并回报被顶掉的', JSON.stringify(backlog) === JSON.stringify({ queue: ['新的'], dropped: ['旧一', '旧二'] }), JSON.stringify(backlog))
  push('代际：旧代淘汰、当前代与关闭态不淘汰', isSpeakStale(true, 3, 4) && !isSpeakStale(true, 4, 4) && !isSpeakStale(false, 3, 4), 'true/false/false')

  probeStep('edge：入队即全部发车，产出仍按原顺序')
  // —— edge：入队即全部发车，产出仍按原顺序 ——
  {
    const f = makeFake()
    const seen: string[] = []
    const outcomePromise = speakPipeline(base('edge', SEG_TEXT, { split: true, segmentChars: SEGMENT_CHARS_MIN, adapters: f.adapters }), (segment) => { seen.push(segment.text) })
    push('edge：入队即全部发车', JSON.stringify(f.calls) === JSON.stringify([`edge:${SEGMENTS[0]}`, `edge:${SEGMENTS[1]}`, `edge:${SEGMENTS[2]}`]), JSON.stringify(f.calls))
    push('edge：合成未回，段不投递', seen.length === 0, `${seen.length}`)
    gateFor(f.gates, `edge:${SEGMENTS[2]}`)!.open(wav(SEGMENTS[2]))
    gateFor(f.gates, `edge:${SEGMENTS[1]}`)!.open(wav('乙'))
    await tick()
    push('edge：乱序完成不影响产出顺序', seen.length === 0, seen.join('|'))
    gateFor(f.gates, `edge:${SEGMENTS[0]}`)!.open(wav('甲'))
    const outcome = await outcomePromise
    push('edge：三段按原顺序全投出', seen.join('') === SEG_TEXT && outcome.delivered === 3 && outcome.synthFailed === false, `${seen.join('|')} / ${JSON.stringify(outcome)}`)
  }

  probeStep('edge：合成全败 → 段照旧按序产出（audio 空），记 synthFailed，绝不回退')
  // —— edge：合成全败 → 段照旧按序产出（audio 空），记 synthFailed，绝不回退 ——
  {
    const seen: SpeechSegment[] = []
    const outcome = await speakPipeline(
      base('edge', SEG_TEXT, {
        split: true,
        segmentChars: SEGMENT_CHARS_MIN,
        adapters: { edge: () => Promise.resolve(null), offline: () => Promise.resolve(null), sovits: () => Promise.resolve(null) }
      }),
      (segment) => { seen.push(segment) }
    )
    push('edge：合成全败也按序产出空段', seen.length === SEGMENTS.length && seen.every((segment) => segment.audio === null), `${seen.length} 段（切段器给了 ${SEGMENTS.length} 段）`)
    push('edge：全败记 synthFailed', outcome.synthFailed === true && outcome.dropped === 0, JSON.stringify(outcome))
  }

  probeStep('offline：切段被无视，单段；过期整句在推理前拦截')
  // —— offline：切段被无视，单段；过期整句在推理前拦截 ——
  {
    const f = makeFake()
    const seen: string[] = []
    const outcome = await speakPipeline(base('offline', SEG_TEXT, { split: true, adapters: f.adapters }), (segment) => { seen.push(segment.text) })
    push('offline：切段被无视（只合成一次）', f.calls.length === 1 && f.calls[0] === `offline:${SEG_TEXT}`, JSON.stringify(f.calls))
    push('offline：单段产出为 wav', outcome.delivered === 1 && seen.join('') === SEG_TEXT, JSON.stringify(outcome))
  }
  {
    const f = makeFake()
    const outcome = await speakPipeline(base('offline', '旧的', { ts: 1, cutoff: 2, dropStale: true, adapters: f.adapters }))
    push('offline：过期整句零推理跳过', f.calls.length === 0 && outcome.delivered === 0 && outcome.dropped === 1 && outcome.synthFailed === false, JSON.stringify({ calls: f.calls, outcome }))
  }

  probeStep('system：不下发音频、不算合成失败')
  // —— system：不下发音频、不算合成失败 ——
  {
    const f = makeFake()
    let audio: Buffer | null = Buffer.alloc(1)
    let mime: string | null = 'x'
    const outcome = await speakPipeline(base('system', '自己念', { adapters: f.adapters }), (segment) => {
      audio = segment.audio
      mime = segment.audioMime
    })
    push('system：交渲染层、无音频无 mime', audio === null && mime === null && f.calls.length === 0, 'audio/mime 均 null')
    push('system：不算合成失败', outcome.delivered === 1 && outcome.synthFailed === false, JSON.stringify(outcome))
  }

  probeStep('GV 懒队列：排队单被顶掉永不合成，当场结账')
  // —— GV 懒队列：排队单被顶掉永不合成，当场结账 ——
  {
    const f = makeFake()
    const seen: string[] = []
    const outcomeP = speakPipeline(base('sovits', '前排的', { adapters: f.adapters }), (segment) => { seen.push(segment.text) })
    const outcomeA = speakPipeline(base('sovits', SEG_TEXT, { split: true, segmentChars: SEGMENT_CHARS_MIN, dropStale: true, adapters: f.adapters }), () => undefined)
    const outcomeB = speakPipeline(base('sovits', '新来的', { dropStale: true, adapters: f.adapters }), (segment) => { seen.push(segment.text) })
    const a = await outcomeA
    push('GV：被顶掉的排队单永不合成', JSON.stringify(a) === JSON.stringify({ delivered: 0, dropped: 3, synthFailed: false }) && JSON.stringify(f.calls) === JSON.stringify(['sovits:前排的']), JSON.stringify(a))
    gateFor(f.gates, 'sovits:前排的')!.open(wav('p'))
    const p = await outcomeP
    gateFor(f.gates, 'sovits:新来的')!.open(wav('b'))
    const b = await outcomeB
    push('GV：P 豁免代际、播完接 B，A 全程未合成', seen.join('|') === '前排的|新来的' && JSON.stringify(f.calls) === JSON.stringify(['sovits:前排的', 'sovits:新来的']) && p.delivered === 1 && b.delivered === 1, JSON.stringify({ calls: f.calls, seen }))
  }

  // —— GV：不预取，播放期间不碰显卡（下一段合成的唯一触发点是上一段播完）——
  {
    const f = makeFake()
    const seen: string[] = []
    // 播放闸：onSegment 交回一个「这段还在播」的 promise，由测试手动放行——真实声出腿就是这样
    // await 播完的（voice-out 的 onSegment 等 player.play 结束）。用同步 onSegment 建模等于
    // 「播放瞬间结束」，那这条断言永远不可能成立。
    const plays: (() => void)[] = []
    const outcome = speakPipeline(
      base('sovits', SEG_TEXT, { split: true, segmentChars: SEGMENT_CHARS_MIN, adapters: f.adapters }),
      (segment) => {
        seen.push(segment.text)
        return new Promise<void>((resolve) => plays.push(resolve))
      }
    )
    gateFor(f.gates, `sovits:${SEGMENTS[0]}`)!.open(wav('甲'))
    await tick()
    push('GV：本段出声时不发下一段的合成', !f.calls.includes(`sovits:${SEGMENTS[1]}`) && seen.join('') === SEGMENTS[0], JSON.stringify({ calls: f.calls, seen }))
    plays[0]!()
    await tick()
    push('GV：本段收尾才轮到下一段合成', f.calls.includes(`sovits:${SEGMENTS[1]}`) && !f.calls.includes(`sovits:${SEGMENTS[2]}`), JSON.stringify({ calls: f.calls, seen }))
    gateFor(f.gates, `sovits:${SEGMENTS[1]}`)!.open(wav('乙'))
    await tick()
    plays[1]!()
    await tick()
    push('GV：第三段等第二段播完才发车', f.calls.includes(`sovits:${SEGMENTS[2]}`) && seen.join('') === SEGMENTS.slice(0, 2).join(''), JSON.stringify({ calls: f.calls, seen }))
    gateFor(f.gates, `sovits:${SEGMENTS[2]}`)!.open(wav(SEGMENTS[2]))
    await tick()
    plays[2]!()
    const o = await outcome
    push('GV：三段全出', o.delivered === 3 && seen.join('') === SEG_TEXT, JSON.stringify(o))
  }

  // —— GV：放到一半来了新的，当前段连同余段一并作废（音频已花掉，认了）——
  {
    const f = makeFake()
    const seen: string[] = []
    const outcomeA = speakPipeline(base('sovits', SEG_TEXT, { split: true, segmentChars: SEGMENT_CHARS_MIN, dropStale: true, adapters: f.adapters }), (segment) => { seen.push(segment.text) })
    gateFor(f.gates, `sovits:${SEGMENTS[0]}`)!.open(wav('甲'))
    const outcomeB = speakPipeline(base('sovits', '新的', { dropStale: true, adapters: f.adapters }), (segment) => { seen.push(segment.text) })
    const a = await outcomeA
    push('GV：中途变代，余段零推理作废（三段全作废、零推理）', a.delivered === 0 && a.dropped === SEGMENTS.length && seen.length === 0 && JSON.stringify(f.calls) === JSON.stringify([`sovits:${SEGMENTS[0]}`, 'sovits:新的']), JSON.stringify({ outcome: a, calls: f.calls }))
    gateFor(f.gates, 'sovits:新的')!.open(wav('新'))
    const b = await outcomeB
    push('GV：新单照常出声', b.delivered === 1 && seen.join('|') === '新的', JSON.stringify({ outcome: b, seen }))
  }

  probeStep('lane：同车道按 FIFO 投递，合成照旧入队即发车')
  // —— lane：同车道按 FIFO 投递，合成照旧入队即发车 ——
  {
    const f = makeFake()
    const seen: string[] = []
    const o1 = speakPipeline(base('edge', '甲', { adapters: f.adapters, lane: 'probe-lane' }), (segment) => { seen.push(segment.text) })
    const o2 = speakPipeline(base('edge', '乙', { adapters: f.adapters, lane: 'probe-lane' }), (segment) => { seen.push(segment.text) })
    push('lane：两单同时发车、投递排队', JSON.stringify(f.calls) === JSON.stringify(['edge:甲', 'edge:乙']) && seen.length === 0, JSON.stringify({ calls: f.calls, seen }))
    gateFor(f.gates, 'edge:甲')!.open(wav('甲'))
    await tick()
    push('lane：先单未完，后单不插队', seen.join('') === '甲', seen.join('|'))
    gateFor(f.gates, 'edge:乙')!.open(wav('乙'))
    const outcomes = await Promise.all([o1, o2])
    push('lane：FIFO 产出', seen.join('|') === '甲|乙' && outcomes.every((o) => o.delivered === 1), `${seen.join('|')} / ${JSON.stringify(outcomes)}`)
  }

  probeStep('GV：合成失败不回退')
  // —— GV：合成失败不回退 ——
  {
    const seen: SpeechSegment[] = []
    const outcome = await speakPipeline(
      base('sovits', '哑的', { adapters: { edge: () => Promise.resolve(null), offline: () => Promise.resolve(null), sovits: () => Promise.resolve(null) } }),
      (segment) => { seen.push(segment) }
    )
    push('GV：合成失败产出空段不回退', seen.length === 1 && seen[0].audio === null, 'audio null')
    push('GV：合成失败记 synthFailed', outcome.synthFailed === true && outcome.dropped === 0, JSON.stringify(outcome))
  }

  // —— 计划值：引擎/嗓音/语言/格式一处算出，四条腿共用（试听把 offline 折成 edge 的那次 bug）——
  {
    const leg = { voice: 'zh-CN-XiaoxiaoNeural', offlineVoice: 'xiao_ya', rate: 1, pitch: 1, text: '别送了' }
    const edge = resolveSpeechPlan({ ...leg, engine: 'edge', edgeVoices: EDGE_VOICES, defaultEdgeVoice: DEFAULT_EDGE_VOICE })
    const offline = resolveSpeechPlan({ ...leg, engine: 'offline' })
    const sovits = resolveSpeechPlan({ ...leg, engine: 'sovits' })
    const system = resolveSpeechPlan({ ...leg, engine: 'system' })
    const all = [edge, offline, sovits, system]
    push('计划：同一句中文四条腿都判 zh', all.every((p) => p.lang === 'zh'), JSON.stringify(all.map((p) => p.lang)))
    push(
      '计划：一个引擎一格格式（离线/GV 是 wav，系统不出音频）',
      edge.mime === 'audio/mpeg' && offline.mime === 'audio/wav' && sovits.mime === 'audio/wav' && system.mime === null,
      JSON.stringify(all.map((p) => p.mime))
    )
    push(
      '计划：离线嗓取离线槽、GV 不选嗓、系统不出音频',
      offline.voice === 'xiao_ya' && sovits.voice === '' && system.voice === '' && edge.voice === leg.voice,
      JSON.stringify(all.map((p) => p.voice))
    )
    push('计划：垃圾引擎打回 edge', resolveSpeechPlan({ ...leg, engine: 'garbage' }).engine === 'edge', 'garbage')
    push(
      '计划：离线嗓不在清单里回落到第一个',
      resolveSpeechPlan({ ...leg, engine: 'offline', offlineVoice: 'nope' }).voice === OFFLINE_VOICES[0].id,
      OFFLINE_VOICES[0].id
    )
    const wild = resolveSpeechPlan({ ...leg, engine: 'edge', rate: 9, pitch: 0.1, edgeVoices: EDGE_VOICES })
    push('计划：语速/音高夹在引擎认的区间', wild.rate === 2 && wild.pitch === 0.7, JSON.stringify({ rate: wild.rate, pitch: wild.pitch }))
    push('计划：英文句判 en', resolveSpeechPlan({ ...leg, engine: 'sovits', text: 'gg wp' }).lang === 'en', 'en')
    push(
      '计划：失败原因按引擎分域（断网不报给离线）',
      speechFailHint('offline').includes('模型') && speechFailHint('edge').includes('断网') && speechFailHint('sovits').includes('GV'),
      speechFailHint('offline')
    )
  }

  const failed = cases.filter((row) => !row.ok)
  for (const row of cases) console.log(`${row.ok ? 'PASS' : 'FAIL'} | ${row.name} | ${row.detail}`)
  console.log(`TTS_PIPELINE_PROBE ${cases.length - failed.length}/${cases.length} ${failed.length === 0 ? 'PASS' : 'FAIL'}`)
  exitProbe(failed.length === 0 )
}
