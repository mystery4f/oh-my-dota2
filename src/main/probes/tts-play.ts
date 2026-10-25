import { BrowserWindow } from 'electron'
import { join } from 'node:path'
import { IPC } from '@shared/ipc'
import { DEFAULT_EDGE_VOICE, synthesizeEdge } from '../services/voice/edge'
import { decideSpeak, speakOptionsFromSettings } from '../services/voice/speech'
import { offlineReady, synthesizeOffline } from '../services/voice/offline'
import type { OfflineVoiceId } from '../../shared/ipc'

/**
 * 朗读播放探针（--tts-play-probe）：把「主进程合成 + 浮层真的出声」拆开验。
 *
 * 为什么要这个探针：朗读失效时，合成成功和播放成功在日志里长得一样——
 * 都是「什么都没发生」。这里把浮层的控制台日志抓回来，明确说出是播放被拒、
 * 音频解码失败，还是整条链路根本没走到。
 */
/** 离线腿用的音色：机器上没装这套模型就静默跳过这条腿（CI 上没有模型）。 */
const OFFLINE_PROBE_VOICE: OfflineVoiceId = 'eula'
export async function runTtsPlayProbe(): Promise<void> {
  // 先验「该不该念、念什么」这条纯逻辑：它坏了，合成和播放再正常也是静音。
  const speakCases = [
    { name: '中文原话（不翻译也要念）', entry: { id: '1', ts: 0, pending: false, original: '[All] 队友甲: 小心中路，他们可能在打肉山', translated: null }, want: '小心中路，他们可能在打肉山' },
    { name: '英文译文优先', entry: { id: '2', ts: 0, pending: false, original: '[Team] X: push top', translated: '推上路' }, want: '推上路' },
    { name: '有英雄名就念「谁说」', entry: { id: '5', ts: 0, pending: false, original: '[lina] [队友] [队友甲] ⚔ push top', translated: '推上路', speaker: 'lina' }, want: '莉娜说，推上路' },
    { name: '中文原话也带英雄名', entry: { id: '6', ts: 0, pending: false, original: '[pudge] [敌方] [敌人乙] 🌐 中路没人', translated: null, speaker: 'nevermore' }, want: '影魔说，中路没人' },
    { name: '自己说的不念（哪怕带英雄名）', entry: { id: '8', ts: 0, pending: false, own: true, original: '[nyx_assassin] [我] [Balance(Bot)] 🌐 ::', translated: null, speaker: 'nyx_assassin' }, want: null },
    { name: '还没翻完不念', entry: { id: '3', ts: 0, pending: true, original: '[Team] X: push top' }, want: null },
    { name: '整行只有符号不念', entry: { id: '4', ts: 0, pending: false, original: '[All] ⚔ 🌐' }, want: null }
  ]
  const speakRows = speakCases.map((item) => {
    const got = decideSpeak(item.entry as never, { readAloud: true, voice: '', rate: 1, pitch: 1 })
    return { name: item.name, want: item.want, got: got ? got.text : null, ok: (got ? got.text : null) === item.want }
  })
  const speakOk = speakRows.every((row) => row.ok)
  console.log('TTS_SPEAK_CASES', JSON.stringify({ speakOk, rows: speakRows }))

  // engine 必须从设置一路传进 payload：漏掉时 decideSpeak 默认 edge，离线 WAV 会被标成
  // audio/mpeg 投递，浮层解不开就静音——「离线朗读无效、联网正常」就是这么来的。
  const engineRows = (['system', 'edge', 'offline'] as const).map((engine) => {
    const options = speakOptionsFromSettings({
      ttsReadAloud: true,
      ttsRate: 1,
      ttsPitch: 1,
      ttsVoice: '',
      ttsEngine: engine
    })
    const payload = decideSpeak(
      { id: '7', ts: 0, pending: false, original: '[All] X: push top', translated: '推上路' } as never,
      options
    )
    return { engine, got: payload?.engine ?? null, ok: payload?.engine === engine }
  })
  const engineOk = engineRows.every((row) => row.ok)
  console.log('TTS_SPEAK_ENGINE_CASES', JSON.stringify({ engineOk, rows: engineRows }))

  const text = '小心中路，他们可能在打肉山'
  const audio = await synthesizeEdge(text, DEFAULT_EDGE_VOICE, 1)
  console.log('TTS_PLAY_SYNTH', JSON.stringify({ bytes: audio?.length ?? 0 }))

  const win = new BrowserWindow({
    show: false,
    width: 420,
    height: 200,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })

  const logs: string[] = []
  win.webContents.on('console-message', (_event, _level, message) => {
    logs.push(message)
    console.log('RENDERER_LOG', message)
  })

  if (process.env.ELECTRON_RENDERER_URL) {
    await win.loadURL(`${process.env.ELECTRON_RENDERER_URL}/overlay.html`)
  } else {
    await win.loadFile(join(__dirname, '../renderer/overlay.html'))
  }

  if (audio) {
    win.webContents.send(IPC.VOICE_SPEAK, {
      text,
      lang: 'zh',
      rate: 1,
      voice: DEFAULT_EDGE_VOICE,
      engine: 'edge',
      audio: audio.toString('base64'),
      audioMime: 'audio/mpeg'
    })
  }
  // 没有音频也发一次：这条走系统嗓子，用来区分「合成没成」还是「播放被拒」。
  else {
    win.webContents.send(IPC.VOICE_SPEAK, {
      text,
      lang: 'zh',
      rate: 1,
      voice: DEFAULT_EDGE_VOICE,
      engine: 'system'
    })
  }
  // 离线腿：真实跑一遍「合成 WAV → audio/wav 投递 → 浮层播放」。mime 标错这条腿会先报
  // VOICE_AUDIO_ERROR——离线朗读失效在日志里就是「什么都没发生」，这里把它变成一句断言。
  const offlineWav = offlineReady(OFFLINE_PROBE_VOICE)
    ? await synthesizeOffline(text, OFFLINE_PROBE_VOICE, 1)
    : null
  console.log('TTS_PLAY_OFFLINE_SYNTH', JSON.stringify({ bytes: offlineWav?.length ?? 0 }))
  if (offlineWav) {
    win.webContents.send(IPC.VOICE_SPEAK, {
      text,
      lang: 'zh',
      rate: 1,
      voice: '',
      engine: 'offline',
      audio: offlineWav.toString('base64'),
      audioMime: 'audio/wav'
    })
  }

  // 队列串行播：edge 一句约 4 秒、离线一句再 3 秒——等 10 秒两条 VOICE_PLAY_OK 才都落进日志。
  await new Promise((resolve) => setTimeout(resolve, 10_000))
  const playOkCount = logs.filter((line) => line.includes('VOICE_PLAY_OK')).length
  const expectedPlays = Number(Boolean(audio)) + Number(Boolean(offlineWav))
  const failed = logs.filter((line) => line.includes('VOICE_PLAY_FAILED'))
  const broken = logs.filter((line) => line.includes('VOICE_AUDIO_ERROR'))
  console.log(
    'TTS_PLAY_RESULT',
    JSON.stringify({
      ok: speakOk && engineOk && broken.length === 0 && (expectedPlays === 0 || playOkCount >= expectedPlays),
      speakOk,
      engineOk,
      playOkCount,
      expectedPlays,
      failed,
      broken
    })
  )
  win.destroy()
  const { app } = await import('electron')
  app.exit(0)
}
