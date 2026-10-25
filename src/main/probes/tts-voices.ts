import { app } from 'electron'
import { EDGE_VOICES, DEFAULT_EDGE_VOICE } from '@shared/tts-voices'
import { synthesizeEdge } from '../services/voice/edge'

/**
 * 逐个嗓子合成同一句话，把「列表里挂着但实际上哑的」揪出来。
 * 免费端点的音色集和 Azure 官方文档并不完全一致——`zh-CN-XiaoxiaoDialectsNeural`
 * 就是文档里有、这边直接回 Unsupported voice 的例子；英文嗓子读中文则回「没有音频」。
 * 面板能选的东西必须能出声，所以每加一个嗓子就跑一次这个探针。
 */
const LINE = '莉娜说，推上路'

export async function runTtsVoicesProbe(): Promise<void> {
  const rows: { id: string; label: string; ok: boolean; ms: number; bytes: number; err?: string }[] = []
  for (const voice of EDGE_VOICES) {
    const at = Date.now()
    const audio = await synthesizeEdge(LINE, voice.id, 1, 1)
    rows.push({
      id: voice.id,
      label: voice.label,
      ok: Boolean(audio && audio.length > 0),
      ms: Date.now() - at,
      bytes: audio?.length ?? 0
    })
    const last = rows[rows.length - 1]
    console.log('TTS_VOICE', JSON.stringify(last))
  }
  const failed = rows.filter((row) => !row.ok)
  const defaultOk = rows.find((row) => row.id === DEFAULT_EDGE_VOICE)?.ok === true
  console.log(
    'TTS_VOICES_RESULT',
    JSON.stringify({
      total: rows.length,
      ok: rows.length - failed.length,
      failed: failed.map((row) => row.id),
      defaultOk
    })
  )
  await new Promise((resolve) => setTimeout(resolve, 500))
  app.exit(failed.length === 0 && defaultOk ? 0 : 1)
}
