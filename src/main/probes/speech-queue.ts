import type { SpeechSynthAdapters } from '../services/voice/speech-pipeline'
import { speechQueueSnapshot, speakPipeline, stopSpeech } from '../services/voice/speech-pipeline'
import type { SpeechRequest } from '../services/voice/speech-pipeline'
import { queueLine, stopLine } from '@shared/speech-queue'
import { finishProbe, probeCases } from './harness'

/**
 * 语音队列与打断（#88）的时序锁：真管线跑一遍，假引擎用闸门控住合成时机。
 *
 * 三条验收逐条钉住：
 * - 停止后一句话都不再开新的段（不是「大多数时候不开」）；
 * - 面板看到的余量在停止后归零（快照由主进程出，面板只画）；
 * - 停止是一次性的：停下再新的句子照常出声，标志不许粘住。
 */

function gate(): { promise: Promise<Buffer | null>; open: (audio: Buffer | null) => void } {
  let open!: (audio: Buffer | null) => void
  const promise = new Promise<Buffer | null>((resolve) => {
    open = resolve
  })
  return { promise, open }
}

const wav = (text: string): Buffer => Buffer.from(`wav:${text}`)
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0))

/** 逐段闸门：每个合成调用都挂住，由断言自己决定什么时候出音频。 */
function makeGated(): {
  adapters: SpeechSynthAdapters
  gates: Map<string, { promise: Promise<Buffer | null>; open: (audio: Buffer | null) => void }>
} {
  const gates = new Map<string, { promise: Promise<Buffer | null>; open: (audio: Buffer | null) => void }>()
  const hold = (key: string): Promise<Buffer | null> => {
    const g = gate()
    gates.set(key, g)
    return g.promise
  }
  const adapters: SpeechSynthAdapters = {
    edge: (text) => hold(`edge:${text}`),
    offline: (text) => hold(`offline:${text}`),
    sovits: (text) => hold(`sovits:${text}`)
  }
  return { adapters, gates }
}

const base = (engine: SpeechRequest['engine'], text: string, extra: Partial<SpeechRequest> = {}): SpeechRequest => ({
  text,
  engine,
  rate: 1,
  ...extra
})

export async function runSpeechQueueProbe(): Promise<void> {
  const { cases, push } = probeCases()

  // —— 空闲也算一种状态：不许拿空数组冒充「在说」 ——
  const idle = speechQueueSnapshot()
  push('空闲：快照说没在说、没排队', idle.speaking === null && idle.pending === 0 && idle.lanes.length === 0, JSON.stringify(idle))
  push('空闲：面板文案是「空闲」', queueLine(idle) === '空闲', queueLine(idle))

  // —— 内联投递（声出整句）也能被停止：停止后一段都不再开 ——
  {
    const f = makeGated()
    const seen: string[] = []
    const speak = speakPipeline(
      base('edge', '甲，乙，丙', { split: true, segmentChars: 2, adapters: f.adapters }),
      (segment) => {
        seen.push(segment.text)
      }
    )
    push('在说：快照报出正在读的那句', speechQueueSnapshot().speaking === '甲，乙，丙', String(speechQueueSnapshot().speaking))
    f.gates.get('edge:甲，')!.open(wav('甲，'))
    await tick()
    push('在说：第一段已投递后才谈得上停', JSON.stringify(seen) === JSON.stringify(['甲，']), JSON.stringify(seen))
    const stopped = stopSpeech()
    push('内联停止：回报打断属实、排队本来就没有', stopped.interrupted && stopped.cleared === 0, JSON.stringify(stopped))
    // 停止后才回来的两段：合成已完成，投递闸必须自己扔掉。
    f.gates.get('edge:乙，')!.open(wav('乙，'))
    f.gates.get('edge:丙')!.open(wav('丙'))
    const outcome = await speak
    push('停止后：没有任何后续段开播', JSON.stringify(seen) === JSON.stringify(['甲，']), JSON.stringify(seen))
    push('停止后：本次投递的账是 1 播 2 丢', outcome.delivered === 1 && outcome.dropped === 2, JSON.stringify(outcome))
    push('停止完：快照回到空闲', speechQueueSnapshot().speaking === null, JSON.stringify(speechQueueSnapshot()))
  }

  // —— 排队三单一起停：余量归零、排队的那几个当场结单 ——
  {
    const f = makeGated()
    const jobs = [
      speakPipeline(base('edge', '第一句，还长一点', { split: true, segmentChars: 3, lane: 'announce', adapters: f.adapters })),
      speakPipeline(base('edge', '第二句', { lane: 'announce', adapters: f.adapters })),
      speakPipeline(base('edge', '第三句', { lane: 'announce', adapters: f.adapters }))
    ]
    const busy = speechQueueSnapshot()
    push('排队：快照数得出后头还压着两句', busy.lanes.length === 1 && busy.pending >= 2, JSON.stringify(busy))
    push('排队：面板文案带余量', queueLine(busy).includes('余 2'), queueLine(busy))
    const stopped = stopSpeech()
    push('排队停止：清掉了排着的两句、打断了在说的那句', stopped.cleared === 2 && stopped.interrupted, JSON.stringify(stopped))
    const outcomes = await Promise.all(jobs)
    push('排队停止：三单都当场结单，没有一单挂死', outcomes.length === 3 && outcomes[0].delivered === 0, JSON.stringify(outcomes))
    const after = speechQueueSnapshot()
    push('排队停止：快照余量归零、通道清空', after.pending === 0 && after.lanes.length === 0 && after.speaking === null, JSON.stringify(after))
  }

  // —— 停止不许粘住：下一句照常出声 ——
  {
    const adapters: SpeechSynthAdapters = {
      edge: async (text) => wav(text),
      offline: async (text) => wav(text),
      sovits: async (text) => wav(text)
    }
    const seen: string[] = []
    const outcome = await speakPipeline(
      base('edge', '甲，乙，丙', { split: true, segmentChars: 2, adapters }),
      (segment) => {
        seen.push(segment.text)
      }
    )
    push('停止是一次性的：下一句三段全播', outcome.delivered === 3 && seen.length === 3, JSON.stringify(outcome))
    push('读完之后：快照回到空闲', speechQueueSnapshot().speaking === null && speechQueueSnapshot().pending === 0, JSON.stringify(speechQueueSnapshot()))
  }

  // —— 停止回执的三种说法：读到段尾 / 清掉几句 / 本来就没在说 ——
  push('回执：边读边清说全', stopLine({ cleared: 2, interrupted: true }) === '这句读到段尾 · 清掉 2 句排队', stopLine({ cleared: 2, interrupted: true }))
  push('回执：只清排队', stopLine({ cleared: 1, interrupted: false }) === '清掉 1 句排队', stopLine({ cleared: 1, interrupted: false }))
  push('回执：什么都没在说', stopLine({ cleared: 0, interrupted: false }) === '本来就没在说', stopLine({ cleared: 0, interrupted: false }))

  finishProbe('SPEECH_QUEUE_PROBE', cases)
}
