import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VoicePreviewResult } from '@shared/ipc'
import { loadSettings } from '../settings'
import { DEFAULT_EDGE_VOICE, synthesizeEdge } from './edge'

/**
 * 语音试听：合成一句让人当场听见效果，顺便把 mp3 落到 `logs/../tts-preview/preview.mp3`。
 * 真正的朗读走 `speech.ts` → `edge.ts`，这里只是把同一套合成拿来做「按一下听听」。
 */
class TtsAdapter {
  async preview(text: string): Promise<VoicePreviewResult> {
    const draft = text.trim()
    if (!draft) return { ok: false, error: '试听文本为空' }
    const settings = loadSettings()
    const voice = settings.ttsVoice || DEFAULT_EDGE_VOICE
    const audio = await synthesizeEdge(draft, voice, settings.ttsRate, settings.ttsPitch)
    if (!audio) return { ok: false, voice, error: '合成失败（网络或接口不可用）' }
    const dir = join(app.getPath('userData'), 'tts-preview')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'preview.mp3'), audio)
    return { ok: true, audioBase64: audio.toString('base64'), voice }
  }
}

let adapter: TtsAdapter | null = null

export function getTtsAdapter(): TtsAdapter {
  if (!adapter) adapter = new TtsAdapter()
  return adapter
}
