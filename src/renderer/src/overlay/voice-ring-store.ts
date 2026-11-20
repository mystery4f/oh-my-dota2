import type { VoiceRingSignal } from '@shared/voice-ring'

/**
 * 三态指示环的唯一真源（#94）：谁在录、谁在念，只在这里记一次。
 *
 * 录音的真相在 `voice-capture.ts`（一个闭包内的 `recording`），朗读的真相在 `speech.ts`
 * （模块级 `speaking`）。两边都不该再加「顺便通知 UI」的第二个副作用分支，所以这里收一个
 * 极小的订阅点：它们调 setter，环订阅一次。
 */
let recording = false
let speaking = false
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function setRingRecording(on: boolean): void {
  if (recording === on) return
  recording = on
  notify()
}

export function setRingSpeaking(on: boolean): void {
  if (speaking === on) return
  speaking = on
  notify()
}

export function subscribeVoiceRing(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function voiceRingSignal(): VoiceRingSignal {
  return { recording, speaking }
}
