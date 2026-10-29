import { loadSettings } from '../settings'
import { ensureSovitsServer, recordSovitsLog } from './sovits-server'

/**
 * GPT-SoVITS 本地朗读引擎：整合作自带的 api_v2 HTTP 服务（官方 Windows 整合包，
 * `runtime\python.exe api_v2.py -p 9880` 起在本机）。
 *
 * 零样本克隆：音色完全由「参考音频 + 逐字转写」决定，转写和音频对不上音质会明显劣化，
 * 所以两个都由用户在面板里填。服务不在、参考没配、超时，一律返回 null 静默跳过——
 * 绝不回退系统嗓子，两个音色换来换去比不发声更难受（见 AGENTS.md TTS 规约）。
 *
 * 一句一次 GET /tts：本机 GPU 推理（RTX 4060 实测亚秒级），不需要像 Edge 那样预热门连接。
 */

/** api_v2 允许 0.6–1.65；朗读侧的语速滑杆就是 0.7–1.6，直接透传即可。 */
function speedFactor(rate: number): string {
  return String(Math.min(1.65, Math.max(0.6, rate)))
}

/** 合成一句，返回 WAV。任何失败都返回 null（调用方负责「这句不念」）。 */
export async function synthesizeSovits(text: string, rate = 1, lang: 'zh' | 'en' = 'zh'): Promise<Buffer | null> {
  const settings = loadSettings()
  if (!settings.ttsSovitsRefAudio || !settings.ttsSovitsPromptText) {
    recordSovitsLog('TTS_SOVITS_SKIP', { reason: 'ref-not-configured' })
    return null
  }
  // 纯符号行（"?" "！！！"）里没有可发音的字，api_v2 直接回 400——
  // 上游的 empty 判据只看「剥完装饰剩不剩」，剩一个问号也算不空。这里补一道。
  if (!/[\p{L}\p{N}]/u.test(text)) {
    recordSovitsLog('TTS_SOVITS_SKIP', { reason: 'symbol-only' })
    return null
  }
  const base = (settings.ttsSovitsUrl || 'http://127.0.0.1:9880').replace(/\/+$/, '')
  const query = new URLSearchParams({
    text,
    text_lang: lang,
    ref_audio_path: settings.ttsSovitsRefAudio,
    prompt_text: settings.ttsSovitsPromptText,
    prompt_lang: settings.ttsSovitsPromptLang || 'zh',
    media_type: 'wav',
    streaming_mode: 'false',
    // batch 解码：实测 RTX 4060 上 11 字 p50 1.96→1.23s、22 字 3.37→1.91s（2026-10-27）。
    batch_size: '8',
    // 关掉服务端分句并行：我们已经在客户端按标点切成 ≤20 字一段，再并行只会让几路
    // 同时抢 GPU（游戏开着时显存只剩 1.4GB）；实测短句 p50 2.21→1.55s，波动也小一半。
    parallel_infer: 'false',
    speed_factor: speedFactor(rate)
  })
  const started = Date.now()
  const attempt = async (): Promise<Buffer | null> => {
    const response = await fetch(`${base}/tts?${query.toString()}`, { signal: AbortSignal.timeout(30_000) })
    if (!response.ok) {
      recordSovitsLog('TTS_SOVITS_FAIL', { ms: Date.now() - started, status: response.status })
      return null
    }
    const wav = Buffer.from(await response.arrayBuffer())
    if (wav.length === 0) {
      recordSovitsLog('TTS_SOVITS_FAIL', { ms: Date.now() - started, status: 'empty body' })
      return null
    }
    recordSovitsLog('TTS_SOVITS_OK', { ms: Date.now() - started, bytes: wav.length })
    return wav
  }
  try {
    return await attempt()
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    recordSovitsLog('TTS_SOVITS_FAIL', { ms: Date.now() - started, err: message })
    // 连不上通常是「应用刚起、模型还在加载」——重启应用那一局的第一句话不该白丢。
    // 等它起来（ensure 会等到端口就绪或超时）再重试一次；还是不行就静默跳过这一句。
    if (!message.includes('ERR_CONNECTION_REFUSED') && !message.includes('ECONNREFUSED')) return null
    const ready = await ensureSovitsServer().catch(() => false)
    if (!ready) return null
    try {
      return await attempt()
    } catch (retryErr) {
      recordSovitsLog('TTS_SOVITS_FAIL', {
        ms: Date.now() - started,
        retry: true,
        err: retryErr instanceof Error ? retryErr.message : String(retryErr)
      })
      return null
    }
  }
}
