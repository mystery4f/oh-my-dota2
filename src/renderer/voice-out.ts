// 声出隐藏窗口页：主进程要播一段 → 这里选好输出设备（setSinkId）→ 等播放指令。
// 决策都在 @shared/voice-out 和主进程编排器里，这一页只是「扬声器 + 汇报员」。
import {
  DEFAULT_SINK_ID,
  resolveOutputSink,
  type AudioOutputDevice
} from '@shared/voice-out'

interface ActivePlay {
  requestId: number
  player: HTMLAudioElement
  objectUrl: string
  /** START 到达时真正起播的动作：每一单的 player 不同，闭包里带各自的句柄。 */
  begin: () => void
}

let active: ActivePlay | null = null

function reportEnded(requestId: number, ok: boolean, durationMs: number | null, error?: string): void {
  console.log('VOICE_OUT_ENDED', JSON.stringify({ requestId, ok, durationMs, error }))
  window.api.voiceOut.reportEnded({ requestId, ok, durationMs, error })
}

function cleanup(): void {
  if (!active) return
  active.player.pause()
  active.player.src = ''
  URL.revokeObjectURL(active.objectUrl)
  active = null
}

async function waitForMetadata(player: HTMLAudioElement, timeoutMs: number): Promise<void> {
  if (player.readyState >= 1 && Number.isFinite(player.duration)) return
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      player.removeEventListener('loadedmetadata', onMeta)
      player.removeEventListener('error', onErr)
      reject(new Error('读取音频时长超时'))
    }, timeoutMs)
    const onMeta = (): void => {
      clearTimeout(timer)
      player.removeEventListener('error', onErr)
      resolve()
    }
    const onErr = (): void => {
      clearTimeout(timer)
      player.removeEventListener('loadedmetadata', onMeta)
      reject(new Error('音频解码失败'))
    }
    player.addEventListener('loadedmetadata', onMeta, { once: true })
    player.addEventListener('error', onErr, { once: true })
  })
}

async function handlePlay(payload: {
  requestId: number
  audioBase64: string
  audioMime: string
  requestedDevice: string
}): Promise<void> {
  cleanup()
  const { requestId, audioBase64, audioMime, requestedDevice } = payload
  try {
    const devices = (await navigator.mediaDevices.enumerateDevices())
      .filter((device) => device.kind === 'audiooutput')
      .map((device) => ({ deviceId: device.deviceId, label: device.label }) satisfies AudioOutputDevice)
    const choice = resolveOutputSink(requestedDevice, devices)
    console.log('VOICE_OUT_SINK', JSON.stringify({ requestId, ...choice, devices: devices.length }))

    // Blob URL 而不是 data:URL：几 MB 的 base64 塞进 src 会让解码起步变慢。
    const bytes = Uint8Array.from(atob(audioBase64), (ch) => ch.charCodeAt(0))
    const blob = new Blob([bytes], { type: audioMime || 'audio/mpeg' })
    const objectUrl = URL.createObjectURL(blob)
    const player = new Audio(objectUrl)
    player.preload = 'auto'

    // 'default' 是 Chromium 的系统默认输出，setSinkId('default') 虽然合法但没必要碰。
    if (choice.sinkId !== DEFAULT_SINK_ID) {
      try {
        await player.setSinkId(choice.sinkId)
      } catch (err) {
        // 设备在枚举时有、绑定时没了：退回默认输出继续播，提示照报，别让测试哑掉。
        console.log('VOICE_OUT_SINK_FAIL', JSON.stringify({ requestId, error: String(err) }))
        choice.sinkId = DEFAULT_SINK_ID
        choice.fallback = true
        if (!choice.hint) choice.hint = '输出设备绑定失败，已回退系统默认输出'
      }
    }

    await waitForMetadata(player, 8000)
    const durationMs = Number.isFinite(player.duration) ? Math.round(player.duration * 1000) : null

    player.onended = () => {
      reportEnded(requestId, true, durationMs)
      if (active?.requestId === requestId) cleanup()
    }
    player.onerror = () => {
      reportEnded(requestId, false, durationMs, '播放失败（音频元素报错）')
      if (active?.requestId === requestId) cleanup()
    }

    const begin = (): void => {
      // 自动播放策略已在主进程关闭（autoplay-policy=no-user-gesture-required）。
      void player.play().catch((err) => {
        reportEnded(requestId, false, null, `播放被拒绝: ${String(err)}`)
        cleanup()
      })
    }

    active = { requestId, player, objectUrl, begin }
    window.api.voiceOut.reportReady({
      requestId,
      ok: true,
      durationMs,
      sinkId: choice.sinkId,
      sinkLabel: choice.label,
      fallback: choice.fallback,
      hint: choice.hint
    })
  } catch (err) {
    cleanup()
    window.api.voiceOut.reportReady({
      requestId,
      ok: false,
      durationMs: null,
      sinkId: DEFAULT_SINK_ID,
      sinkLabel: '',
      fallback: false,
      hint: null,
      error: err instanceof Error ? err.message : String(err)
    })
  }
}

window.api.voiceOut.onPlay((payload) => {
  void handlePlay(payload)
})

// START 监听只在模块加载时挂一次（每单 play 都挂会越积越多，SET 里的旧句柄永不退场）。
// active 闭包在回调时才读，永远指着当前这一单；cleanup() 后 begin 自动变 no-op。
window.api.voiceOut.onStart((startId) => {
  if (active && active.requestId === startId) active.begin()
})
