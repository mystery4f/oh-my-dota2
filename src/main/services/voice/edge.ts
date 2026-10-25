import { EdgeTTS } from '@andresaya/edge-tts'
import { DEFAULT_EDGE_VOICE, EDGE_VOICES, pitchSpec, rateSpec } from '@shared/tts-voices'
import { readCachedAudio, ttsCacheKey, writeCachedAudio } from './tts-cache'

/**
 * Edge 神经语音（走微软的免费朗读接口，不开账号、不花钱）。
 * 为什么不用系统自带的 speechSynthesis：Windows 上中文只有「慧慧」一个嗓子，
 * 是十年前的拼接音，念游戏聊天像播报；Edge 的晓晓/晓伊是神经语音，听起来是正常人。
 */

export { EDGE_VOICES, DEFAULT_EDGE_VOICE } from '@shared/tts-voices'

/** 单次合成的上限：超时或失败就这一句不念（宁可少一句，也不要突然换成系统嗓子变音）。 */
export const EDGE_TIMEOUT_MS = 6000
/** 第一次只等这么久：手慢了立刻重试，别把整句朗读卡在 4 秒上。 */
export const EDGE_FIRST_TIMEOUT_MS = 2500

/** 最近念过的句子直接复用音频：同一句在聊天里反复出现，没必要每次都联网。 */
const CACHE_MAX = 80
const cache = new Map<string, Buffer>()

function remember(key: string, audio: Buffer): void {
  cache.set(key, audio)
  while (cache.size > CACHE_MAX) {
    const oldest = cache.keys().next().value
    if (oldest === undefined) break
    cache.delete(oldest)
  }
}

// 语速/音高的换算挪到 shared 了：试听与朗读共用一份，探针也能直接断言。
/**
 * 长连接池：实测「冷握手」1–21 秒，「热连接」每句 1–2 秒。
 * 每句都 new 一次等于每句都赌一次冷启动，这就是「一下快一下慢」的主要来源。
 * 池子只放 2 条：多了会被微软限流（直接 429），少了连发三句要排队三轮。
 */
const POOL_SIZE = 2
const slots: { client: EdgeTTS | null; chain: Promise<unknown>; queued: number }[] = Array.from(
  { length: POOL_SIZE },
  () => ({ client: null, chain: Promise.resolve(), queued: 0 })
)

/** 队列最短的一条去吃这句；都不是空闲也照样排进去，顺序即公平。 */
function pickSlot(): number {
  let best = 0
  for (let index = 1; index < slots.length; index += 1) {
    if (slots[index].queued < slots[best].queued) best = index
  }
  slots[best].queued += 1
  return best
}

/**
 * 合成一句 mp3。返回 null 表示这条路当下不可用（断网、限流、接口变了、超时），
 * 调用方决定怎么办——当前策略是「这一句不念」，绝不换嗓子。
 */
export async function synthesizeEdge(
  text: string,
  voice: string,
  rate: number,
  /** 音高倍率，1 = 原声；缺省时按原声合成（老调用点不用改）。 */
  pitch = 1
): Promise<Buffer | null> {
  const trimmed = text.trim()
  if (!trimmed) return null
  // 设置里可能躺着已下线或英文的嗓子（读中文回「没有音频」），一律挡回默认中文嗓。
  const voiceName = voice && EDGE_VOICES.some((item) => item.id === voice) ? voice : DEFAULT_EDGE_VOICE
  if (voice !== voiceName) {
    console.log('EDGE_TTS_VOICE_FALLBACK', JSON.stringify({ asked: voice, used: voiceName }))
  }
  const rateValue = rateSpec(rate)
  const pitchValue = pitchSpec(pitch)
  // 键里必须带音高：同一个嗓子调过音高就是另一段音频，否则会拿旧缓存糊上去。
  const key = `${voiceName}|${rateValue}|${pitchValue}|${trimmed}`
  const hit = cache.get(key)
  if (hit) return hit
  // 进程内缓存不跨重启；磁盘里存的那份让「昨天说过的同一句」今天还是 0 延迟。
  const persisted = readCachedAudio(ttsCacheKey(key))
  if (persisted) {
    remember(key, persisted)
    console.log("EDGE_TTS_DISK_HIT", JSON.stringify({ bytes: persisted.length }))
    return persisted
  }

  const index = pickSlot()
  const slot = slots[index]
  // 同一个 client 上并发调用会串流，必须一条一条走；跨 slot 才是并行的。
  const task = slot.chain.then(async (): Promise<Buffer | null> => {
    const started = Date.now()
    if (!slot.client) slot.client = new EdgeTTS()
    try {
      const work = (async (): Promise<Buffer> => {
        await slot.client!.synthesize(trimmed, voiceName, {
          rate: rateValue,
          pitch: pitchValue
        })
        return Buffer.from(await slot.client!.toBuffer())
      })()
      const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), EDGE_TIMEOUT_MS))
      const audio = await Promise.race([work, timeout])
      if (audio && audio.length >= 512) {
        console.log('EDGE_TTS_OK', JSON.stringify({ ms: Date.now() - started, bytes: audio.length, slot: index }))
        remember(key, audio)
        writeCachedAudio(ttsCacheKey(key), audio)
        return audio
      }
      console.log('EDGE_TTS_EMPTY', JSON.stringify({ ms: Date.now() - started, slot: index }))
    } catch (err) {
      // 这条路是「锦上添花」：失败只留一行日志，绝不打断朗读。
      console.log(
        'EDGE_TTS_FAILED',
        JSON.stringify({ ms: Date.now() - started, slot: index, err: err instanceof Error ? err.message : String(err) })
      )
    }
    // 这次连接已经不可信，丢掉；下一句重新握手（账面上只亏这一句）。
    slot.client = null
    return null
  })
  slot.chain = task.catch(() => undefined)
  task.finally(() => {
    slot.queued = Math.max(0, slot.queued - 1)
  })
  return task
}

/** 预热：应用启动时就握好手，第一句真实台词不用等 1–21 秒的冷启动。 */
export function warmEdge(): void {
  void synthesizeEdge('嗯', DEFAULT_EDGE_VOICE, 1)
}
