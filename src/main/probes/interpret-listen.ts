/**
 * 同传监听探针（issue #127「Can we hear the game at all」）。
 *
 * 要答的是四件事，这一版先钉死前两件不需要对局的部分：
 *   A. Electron 37 / Windows 上 `getDisplayMedia({audio:true})` 到底能不能拿到环回音轨，采样率多少；
 *   B. 这条轨道真的装着系统声音吗——探针自己在同一个窗口里放一段 1 kHz 的静音级测试音，
 *      再从环回里把它找回来（沉默段 RMS → 有声段 RMS → 1 kHz 与旁带功率比）。
 *
 * 后两件（对局音上的 VAD 误触发、环回 vs 麦克风的错字率、端到端延迟）必须有真实对局音，
 * 需要人开着游戏配合，见 docs/NOTES.md 里这一条的记录方式。
 *
 * 第三段（有真人录音时）把一句已知文本从扬声器放出去，再经环回抓回来识别，
 * 直接给出「环回这条路比原文件多错几个字」的证据——不需要开游戏，也不需要麦克风。
 *
 * 只出测量，不改产品路径：抓到的音频落 `logs/interpret-listen/`，谁都能拿去听。
 */
import { BrowserWindow, session } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { reportProbe } from './harness'

/** 沉默段与测试音段各录多久：够算 RMS，又不会把机器占太久。 */
const SILENCE_MS = 1_200
const TONE_MS = 1_200
/**
 * 第三段录多久的「房间里真实在响的东西」。
 *
 * 这一段才是回答问题 B 的素材：机器上只要有别的音频在放（直播、音乐、对局），
 * 环回抓到的就是它，拿它跑 VAD/降噪/识别，才知道这条路上到底会切出什么。
 */
const ROOM_MS = 12_000
/** 测试音的音量：能测出来就行，别把睡着的人吵醒。 */
const TONE_GAIN = 0.03
const TONE_HZ = 1_000
/** 旁带：证明抓到的确实是那个频率，不是一段被广播坏了的噪声。 */
const SIDE_HZ = 500

interface CaptureReport {
  error?: string
  /** 视频轨拿不到时说明它是否被要求过：audio-only 的 getDisplayMedia 在 Chromium 上并不是处处允许。 */
  requested?: string
  sampleRate?: number
  channelCount?: number
  settings?: { sampleRate?: number; channelCount?: number; deviceId?: string; label?: string }
  chunks?: number
  frames?: number
  silenceRms?: number
  toneRms?: number
  tonePower?: number
  sidePower?: number
  elapsedMs?: number
  wav16k?: string
  room16k?: string
  roomMs?: number
}

/** 页面侧脚本：开环回、录两段、自己算 RMS 与 1 kHz 功率，再把 16k 单声道 WAV 交回来。 */
function captureScript(): string {
  return `(async () => {
  const started = performance.now()
  let stream = null
  let note = ''
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: false })
  } catch (error) {
    note = 'audio-only: ' + (error && error.message ? error.message : String(error))
    // 有的版本只肯在同时要视频时走环回：退一步再试，把这一步的结论一起带回去。
    try {
      stream = await navigator.mediaDevices.getDisplayMedia({ audio: true, video: true })
    } catch (error2) {
      return { error: note + ' / with-video: ' + (error2 && error2.message ? error2.message : String(error2)) }
    }
  }
  const track = stream.getAudioTracks()[0]
  if (!track) return { error: note + ' / no audio track', requested: note }
  const settings = track.getSettings ? track.getSettings() : {}
  stream.getVideoTracks().forEach((item) => item.stop())

  const ctx = new AudioContext()
  if (ctx.state === 'suspended') await ctx.resume()
  const source = ctx.createMediaStreamSource(stream)
  const sink = ctx.createGain()
  sink.gain.value = 0
  const proc = ctx.createScriptProcessor(2048, 1, 1)
  const chunks = []
  let collecting = false
  proc.onaudioprocess = (event) => {
    if (!collecting) return
    chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)))
  }
  source.connect(proc)
  proc.connect(sink)
  sink.connect(ctx.destination)

  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  const take = async (ms) => {
    chunks.length = 0
    collecting = true
    await wait(ms)
    collecting = false
    const total = chunks.reduce((sum, item) => sum + item.length, 0)
    const merged = new Float32Array(total)
    let at = 0
    for (const item of chunks) { merged.set(item, at); at += item.length }
    return merged
  }
  const rms = (samples) => {
    if (!samples.length) return 0
    let sum = 0
    for (let i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i]
    return Math.sqrt(sum / samples.length)
  }
  // Goertzel：只在目标频点上算功率，比整段 FFT 便宜且够用。
  const power = (samples, hz, rate) => {
    if (!samples.length) return 0
    const w = (2 * Math.PI * hz) / rate
    const coeff = 2 * Math.cos(w)
    let s0 = 0
    let s1 = 0
    let s2 = 0
    for (let i = 0; i < samples.length; i += 1) {
      s0 = samples[i] + coeff * s1 - s2
      s2 = s1
      s1 = s0
    }
    return Math.sqrt(Math.max(0, s1 * s1 + s2 * s2 - coeff * s1 * s2)) / samples.length
  }

  const silence = await take(${SILENCE_MS})
  const osc = ctx.createOscillator()
  const gain = ctx.createGain()
  osc.frequency.value = ${TONE_HZ}
  gain.gain.value = ${TONE_GAIN}
  osc.connect(gain)
  gain.connect(ctx.destination)
  osc.start()
  const tone = await take(${TONE_MS})
  osc.stop()
  // 到头来最有用的可能是这一段：没人叫它录什么，它录的是机器此刻真实的输出。
  const room = await take(${ROOM_MS})

  const rate = ctx.sampleRate
  const toWav = (samples) => {
    const ratio = rate / 16000
    const length = Math.floor(samples.length / ratio)
    const view = new DataView(new ArrayBuffer(44 + length * 2))
    const text = (at, value) => { for (let i = 0; i < value.length; i += 1) view.setUint8(at + i, value.charCodeAt(i)) }
    text(0, 'RIFF')
    view.setUint32(4, 36 + length * 2, true)
    text(8, 'WAVEfmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true)
    view.setUint16(22, 1, true)
    view.setUint32(24, 16000, true)
    view.setUint32(28, 32000, true)
    view.setUint16(32, 2, true)
    view.setUint16(34, 16, true)
    text(36, 'data')
    view.setUint32(40, length * 2, true)
    for (let i = 0; i < length; i += 1) {
      const start = Math.floor(i * ratio)
      const end = Math.min(samples.length, Math.floor((i + 1) * ratio))
      let sum = 0
      for (let j = start; j < end; j += 1) sum += samples[j]
      const value = end > start ? sum / (end - start) : 0
      view.setInt16(44 + i * 2, Math.max(-1, Math.min(1, value)) * 0x7fff, true)
    }
    const bytes = new Uint8Array(view.buffer)
    let binary = ''
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
    return btoa(binary)
  }

  track.stop()
  await ctx.close()
  return {
    requested: note,
    sampleRate: rate,
    channelCount: source.channelCount,
    settings: { sampleRate: settings.sampleRate, channelCount: settings.channelCount, label: settings.deviceId ? 'device' : undefined },
    chunks: chunks.length,
    frames: tone.length,
    silenceRms: rms(silence),
    toneRms: rms(tone),
    tonePower: power(tone, ${TONE_HZ}, rate),
    sidePower: power(tone, ${SIDE_HZ}, rate),
    elapsedMs: Math.round(performance.now() - started),
    wav16k: toWav(tone),
    room16k: toWav(room),
    roomMs: Math.round((room.length / rate) * 1000)
  }
})()`
}

export async function runInterpretListenProbe(): Promise<void> {
  // 环回音轨只能由渲染进程经 getDisplayMedia 申请；主进程这边负责把「给哪一路」定下来。
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    callback({ audio: 'loopback' })
  })
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(permission === 'media' || permission === 'display-capture')
  )

  const win = new BrowserWindow({
    show: false,
    skipTaskbar: true,
    width: 320,
    height: 200,
    webPreferences: { sandbox: true, contextIsolation: true, backgroundThrottling: false }
  })

  const fields: Record<string, unknown> = { silenceMs: SILENCE_MS, toneMs: TONE_MS, toneHz: TONE_HZ }
  try {
    // 必须是 file:// 这类可信来源：about:blank（不透明来源）上 navigator.mediaDevices 根本不存在。
    await win.loadFile(join(__dirname, '../renderer/overlay.html'))
    const report = (await win.webContents.executeJavaScript(captureScript(), true)) as CaptureReport
    Object.assign(fields, {
      requested: report.requested ?? null,
      sampleRate: report.sampleRate ?? null,
      channelCount: report.channelCount ?? null,
      trackSettings: report.settings ?? null,
      frames: report.frames ?? null,
      silenceRms: report.silenceRms ?? null,
      toneRms: report.toneRms ?? null,
      tonePower: report.tonePower ?? null,
      sidePower: report.sidePower ?? null,
      elapsedMs: report.elapsedMs ?? null
    })

    const dir = join(app.getPath('userData'), 'logs', 'interpret-listen')
    mkdirSync(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    if (report.wav16k) {
      const file = join(dir, `loopback-${stamp}.wav`)
      writeFileSync(file, Buffer.from(report.wav16k, 'base64'))
      fields.wav = file
    }
    if (report.room16k) {
      const file = join(dir, `room-${stamp}.wav`)
      writeFileSync(file, Buffer.from(report.room16k, 'base64'))
      fields.room = file
      fields.roomMs = report.roomMs ?? null
    }

    if (report.error) {
      reportProbe('INTERPRET_LISTEN_PROBE', false, { ...fields, error: report.error })
      return
    }

    const sampleRate = report.sampleRate ?? 0
    const silenceRms = report.silenceRms ?? 0
    const toneRms = report.toneRms ?? 0
    const tonePower = report.tonePower ?? 0
    const sidePower = report.sidePower ?? 1e-9
    const ratio = tonePower / Math.max(sidePower, 1e-9)
    const heardTone = toneRms > 0.002 && ratio > 5

    const cases = [
      { name: '环回音轨能开', ok: (report.frames ?? 0) > 0, detail: `${report.frames ?? 0} 帧` },
      { name: '采样率报得出来', ok: sampleRate >= 8_000, detail: `${sampleRate} Hz / ${report.channelCount ?? '?'} ch` },
      {
        name: '系统发声能进环回',
        ok: heardTone,
        detail: `静默 ${silenceRms.toFixed(5)} → 测试音 ${toneRms.toFixed(5)}，1 kHz/500 Hz = ${ratio.toFixed(1)}`
      }
    ]
    console.log('INTERPRET_LISTEN_CASES', JSON.stringify(cases))
    reportProbe('INTERPRET_LISTEN_PROBE', cases.every((item) => item.ok), {
      ...fields,
      toneRatio: Number(ratio.toFixed(2)),
      cases: cases.map((item) => ({ name: item.name, ok: item.ok }))
    })
  } catch (error) {
    reportProbe('INTERPRET_LISTEN_PROBE', false, {
      ...fields,
      error: error instanceof Error ? error.message : String(error)
    })
  } finally {
    win.destroy()
  }
}
