import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { VoicePreviewResult } from '@shared/ipc'
import { resolveSpeechPlan, speechFailHint } from '@shared/speech-plan'
import { DEFAULT_EDGE_VOICE, EDGE_VOICES } from '@shared/tts-voices'
import { loadSettings } from '../settings'
import { speakPipeline, type SpeechSegment } from './speech-pipeline'

/**
 * 语音试听：合成一句让人当场听见效果，顺便把音频落到 `tts-preview/`。
 *
 * 引擎、音色、语言、格式全部由计划值给出（shared/speech-plan），与朗读、声出走同一份判断。
 * 老写法把 system 与 offline 都折成 Edge、音色永远取朗读那把 Edge 嗓：面板选「离线音色」
 * 点试听，听到的是 Edge 的声音；返回里也只给 GV 带 mime，离线 WAV 会被渲染层当 mp3 播成静音。
 */
class TtsAdapter {
  async preview(text: string): Promise<VoicePreviewResult> {
    const draft = text.trim()
    if (!draft) return { ok: false, error: '试听文本为空' }
    const settings = loadSettings()
    const plan = resolveSpeechPlan({
      engine: settings.ttsEngine,
      voice: settings.ttsVoice,
      offlineVoice: settings.ttsOfflineVoice,
      rate: settings.ttsRate,
      pitch: settings.ttsPitch,
      text: draft,
      edgeVoices: EDGE_VOICES,
      defaultEdgeVoice: DEFAULT_EDGE_VOICE
    })
    if (plan.mime === null) {
      // 系统嗓子由浮层用 speechSynthesis 念，主进程拿不到音频——试听没有可播的东西。
      // 不偷偷换成 Edge：那正是「引擎跟着面板走」这句注释和实现打架的老账。
      return { ok: false, error: '系统嗓子只能在游戏里听，试听请换一个引擎' }
    }
    const segments: SpeechSegment[] = []
    // 单句直发：不切段、不进队列。mime 一律从计划取，缺了它离线 WAV 就是静音。
    await speakPipeline(
      {
        text: draft,
        engine: plan.engine,
        split: false,
        segmentChars: plan.segmentChars,
        voice: plan.voice,
        rate: plan.rate,
        pitch: plan.pitch,
        lang: plan.lang
      },
      (segment) => {
        segments.push(segment)
      }
    )
    const hit = segments.find((segment) => segment.audio !== null)
    if (!hit || hit.audio === null) return { ok: false, error: speechFailHint(plan.engine) }
    const dir = join(app.getPath('userData'), 'tts-preview')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, plan.mime === 'audio/wav' ? 'preview.wav' : 'preview.mp3'), hit.audio)
    // GV 不选嗓（音色由参考音频/权重决定），回报引擎名，界面才不会显示一个空音色。
    return {
      ok: true,
      audioBase64: hit.audio.toString('base64'),
      audioMime: plan.mime,
      voice: plan.voice || plan.engine
    }
  }
}

let adapter: TtsAdapter | null = null

export function getTtsAdapter(): TtsAdapter {
  if (!adapter) adapter = new TtsAdapter()
  return adapter
}
