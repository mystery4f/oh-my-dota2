import type { SpeakPayload } from '@shared/ipc'

/**
 * 朗读队列（渲染进程侧）：speechSynthesis 只在这边有，system 引擎的出声归这里；
 * edge / offline 的音频由主进程合成好随 payload 下来，这里只管按序播。
 * 队列很短：话说得比嘴快时宁可漏掉旧的，也不要越念越落后（落后的话反而误导）。
 */
const SPEAK_QUEUE_MAX = 6

const speakQueue: SpeakPayload[] = []
let speaking = false

function pickVoice(lang: 'zh' | 'en', wanted: string): SpeechSynthesisVoice | null {
  const voices = window.speechSynthesis.getVoices()
  if (wanted) {
    const exact = voices.find((voice) => voice.name === wanted)
    if (exact) return exact
  }
  const prefix = lang === 'zh' ? 'zh' : 'en'
  return voices.find((voice) => voice.lang.toLowerCase().startsWith(prefix)) ?? null
}

function pumpSpeech(): void {
  if (speaking) return
  const next = speakQueue.shift()
  if (!next) return
  // edge / offline 合成没出音频就整句跳过：宁可这句不出声，也不要突然换成另一个嗓子。
  // 用户对「一下这个声音一下那个声音」的反馈就是这么来的——音色跳变比漏一句更刺耳。
  if (next.engine !== 'system' && !next.audio) {
    console.log('VOICE_SKIP_NO_AUDIO', next.text)
    speaking = false
    pumpSpeech()
    return
  }
  // 主进程合成好的音频（edge=mp3，offline=wav）：直接播，音色比系统嗓子好听一个时代。
  if (next.audio) {
    speaking = true
    const player = new Audio(`data:${next.audioMime ?? 'audio/mpeg'};base64,${next.audio}`)
    // onerror 和 play() 拒绝可能接连都来：只认第一次，第二次会提前泵下一句造成双声道。
    let settled = false
    const done = (): void => {
      if (settled) return
      settled = true
      speaking = false
      pumpSpeech()
    }
    player.onended = done
    player.onerror = () => {
      // 解不开（mime 标错或数据坏了）就整句跳过，不换嗓子出声。
      console.log('VOICE_AUDIO_ERROR', next.text)
      done()
    }
    void player
      .play()
      .then(() => console.log('VOICE_PLAY_OK', next.text))
      .catch((err: unknown) => {
        // 播不出来绝不能静默：Chromium 的 autoplay 策略拒绝时会走到这里。
        console.log('VOICE_PLAY_FAILED', err instanceof Error ? err.message : String(err))
        done()
      })
    return
  }
  const utter = new SpeechSynthesisUtterance(next.text)
  utter.lang = next.lang === 'zh' ? 'zh-CN' : 'en-US'
  utter.rate = next.rate
  const voice = pickVoice(next.lang, next.voice)
  if (voice) utter.voice = voice
  speaking = true
  const done = (): void => {
    speaking = false
    pumpSpeech()
  }
  utter.onend = done
  utter.onerror = done
  window.speechSynthesis.speak(utter)
}

/** 新朗读单入场时该留谁：ts 更旧的整单让位（宁可不念旧的，也别让新消息排在旧消息后面——
 * 「收到第二条还在念第一条」就是这么听出来的），ts 相等（同一条消息的后续段）不清；
 * 容量满了丢最旧。system 引擎的队列只能住在渲染进程（speechSynthesis 只在这边有），
 * 所以这份准入策略是主进程引擎表之外的唯一一份，不是漏改。 */
function admitSpeak(queue: SpeakPayload[], incoming: SpeakPayload): void {
  if (incoming.ts !== undefined) {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const item = queue[index]
      if (item.ts !== undefined && item.ts < incoming.ts) queue.splice(index, 1)
    }
  }
  while (queue.length >= SPEAK_QUEUE_MAX) queue.shift()
  queue.push(incoming)
}

/** 订阅主进程的朗读广播：一行接进 App，行为全部留在本文件。 */
export function subscribeSpeech(): () => void {
  const off = window.api.onVoiceSpeak((payload) => {
    admitSpeak(speakQueue, payload)
    pumpSpeech()
  })
  return off
}
