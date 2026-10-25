import { app } from 'electron'
import { offlineModelDir, offlineReady, offlineStatus, synthesizeOffline } from '../services/voice/offline'

/**
 * 离线朗读引擎的体检：模型在不在、装在哪、每句多快。
 *
 * 判据只看「本地推理有多快」，不联网、不碰 Edge。模型没装时打印下载提示并退出 1——
 * 这样探针本身就是一个明确的安装向导，而不是静默跳过。
 */
const LINES = ['上路小心，他们要来抓你', '推上路，别送了', '打得好']

function percentile(values: number[], ratio: number): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const index = Math.min(sorted.length - 1, Math.floor(ratio * (sorted.length - 1)))
  return sorted[index]
}

export async function runTtsOfflineProbe(): Promise<void> {
  const status = offlineStatus()
  console.log('TTS_OFFLINE_PROBE_STATUS', JSON.stringify({ ...status, userData: app.getPath('userData') }))
  if (!offlineReady()) {
    console.log('TTS_OFFLINE_PROBE_MISSING', JSON.stringify({ dir: offlineModelDir(), hint: '首次使用请在面板点「下载模型」' }))
    console.log('TTS_OFFLINE_PROBE_RESULT', JSON.stringify({ ok: false, reason: 'model-missing' }))
    app.exit(1)
    return
  }
  const rows: { ok: boolean; ms: number; bytes: number; secs: number }[] = []
  for (const line of LINES) {
    const at = Date.now()
    const audio = await synthesizeOffline(line, 'sweet', 1)
    const ms = Date.now() - at
    // 44 字节 WAV 头 + 16 bit 单声道 → 秒数
    const secs = audio ? (audio.length - 44) / 2 / 22050 : 0
    rows.push({ ok: Boolean(audio), ms, bytes: audio?.length ?? 0, secs })
    console.log('TTS_OFFLINE_PROBE_LINE', JSON.stringify({ line, ms, bytes: audio?.length ?? 0 }))
  }
  // 音色预设必须真的不同：同一句话用「标准 / 舒缓 / 轻快」各合成一次，字节数不能撞车。
  // 若全相等，说明预设根本没传到合成器——那「可选多个音色」就是摆样子。
  const base = await synthesizeOffline(LINES[0], 'sweet', 1)
  const lazy = await synthesizeOffline(LINES[0], 'lazy', 1)
  const cute = await synthesizeOffline(LINES[0], 'cute', 1)
  const voiceOk = Boolean(
    base && lazy && cute && base.length !== lazy.length && base.length !== cute.length && lazy.length !== cute.length
  )
  const pitchOk = voiceOk
  const okRows = rows.filter((row) => row.ok)
  const times = okRows.map((row) => row.ms)
  // MeloTTS(fp32, 44.1 kHz) 实测每句 0.36–0.75 s，首句还要算一次引擎加载（~5 s）。
  // 阈值按这代模型定在 1.5 s：比它慢就是回归，而不是「这台机器本来就这样」。
  const ok = okRows.length === LINES.length && percentile(times, 0.5) < 1500 && pitchOk
  console.log(
    'TTS_OFFLINE_PROBE_RESULT',
    JSON.stringify({
      ok,
      pitchOk,
      voiceOk,
      voiceBytes: { sweet: base?.length ?? 0, lazy: lazy?.length ?? 0, cute: cute?.length ?? 0 },
      total: rows.length,
      okCount: okRows.length,
      p50: percentile(times, 0.5),
      p90: percentile(times, 0.9),
      min: times.length ? Math.min(...times) : 0,
      max: times.length ? Math.max(...times) : 0,
      bytes: okRows.reduce((sum, row) => sum + row.bytes, 0)
    })
  )
  app.exit(ok ? 0 : 1)
}
