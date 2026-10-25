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
  const status = offlineStatus('keqing')
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
    const audio = await synthesizeOffline(line, 'keqing', 1)
    const ms = Date.now() - at
    // 44 字节 WAV 头 + 16 bit 单声道 → 秒数
    const secs = audio ? (audio.length - 44) / 2 / 22050 : 0
    rows.push({ ok: Boolean(audio), ms, bytes: audio?.length ?? 0, secs })
    console.log('TTS_OFFLINE_PROBE_LINE', JSON.stringify({ line, ms, bytes: audio?.length ?? 0 }))
  }
  // 语速必须真的传到合成器：同一句话用 1.0 / 0.85 / 0.7 各合成一次，字节数不能撞车。
  // 三个一样长就说明 speed 被吞了——那面板上的语速滑杆就是摆样子。
  const base = await synthesizeOffline(LINES[0], 'keqing', 1)
  const slower = await synthesizeOffline(LINES[0], 'keqing', 0.85)
  const slowest = await synthesizeOffline(LINES[0], 'keqing', 0.7)
  const speedOk = Boolean(
    base &&
      slower &&
      slowest &&
      base.length !== slower.length &&
      base.length !== slowest.length &&
      slower.length !== slowest.length
  )
  const pitchOk = speedOk
  const okRows = rows.filter((row) => row.ok)
  const times = okRows.map((row) => row.ms)
  // keqing(22.05 kHz) 实测每句 0.4–1.0 s，首句还要算一次引擎加载（~2 s）。
  // 阈值按这代模型定在 1.5 s：比它慢就是回归，而不是「这台机器本来就这样」。
  const ok = okRows.length === LINES.length && percentile(times, 0.5) < 1500 && pitchOk
  console.log(
    'TTS_OFFLINE_PROBE_RESULT',
    JSON.stringify({
      ok,
      pitchOk,
      speedOk,
      speedBytes: { fast: base?.length ?? 0, slower: slower?.length ?? 0, slowest: slowest?.length ?? 0 },
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
