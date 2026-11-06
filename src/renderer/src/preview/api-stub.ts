/**
 * Fake `window.api` for `npm run panel:preview`: the panel runs in a plain browser with no
 * Electron, no game and no models behind it.
 *
 * Not part of the app: nothing imports this file, so it never reaches a production bundle.
 * It is still checked by `npm run typecheck:web`, and that check is the point — every stub
 * below is typed against `WindowApi`, so a renamed channel, a changed argument or a changed
 * result shape breaks the build instead of the preview.
 *
 * Coverage is deliberate, not accidental: the dashboard calls ~40 channels and all of them are
 * stubbed here. The rest of the contract (the training window, capture-entries listeners) is
 * behind `missingChannel()`, which logs which channel was hit — a page that starts using one
 * says so in the console instead of throwing `undefined is not a function`.
 *
 * Knobs, all through the URL: `?s=<section>` deep-links a section (the shell reads it),
 * `?engine=<ttsEngine>` and `?outEngine=<ttsOutEngine>` force an engine so the voice-pack rows
 * can be inspected without clicking through the panel.
 */
import { DEFAULT_SETTINGS, type OverlayTextMode, type WindowApi } from '@shared/ipc'
import { DEFAULT_HOTKEYS, describeHotkeys } from '@shared/hotkeys'

const settings: typeof DEFAULT_SETTINGS = structuredClone(DEFAULT_SETTINGS)
const query = new URLSearchParams(location.search)
const engine = query.get('engine') as typeof settings.ttsEngine | null
const outEngine = query.get('outEngine') as typeof settings.ttsOutEngine | null
if (engine) settings.ttsEngine = engine
if (outEngine) settings.ttsOutEngine = outEngine

const hotkeys = { ...DEFAULT_HOTKEYS }
const hotkeyPayload = (): Awaited<ReturnType<WindowApi['getHotkeys']>> => ({
  actions: describeHotkeys(hotkeys).actions,
  error: null
})

const offlineState = (): Awaited<ReturnType<WindowApi['ttsOfflineState']>> => ({
  available: true,
  ready: true,
  bytes: 136314880,
  dir: 'data/tts-offline',
  downloading: false,
  progress: 1,
  error: null
})

const asrState = (): Awaited<ReturnType<WindowApi['asrStatus']>> => ({
  available: true,
  ready: true,
  bytes: 838000000,
  dir: 'data/asr-models',
  downloading: false,
  progress: 1,
  error: null
})

const cacheCounts = (): Awaited<ReturnType<WindowApi['translationCacheInspect']>> => ({
  model: 'deepseek-chat',
  pairs: 42,
  conversations: 7
})

/** 浮层状态可变：点了按钮就得看到变，否则按钮等于假的。 */
const overlay = {
  visible: true,
  textMode: 'translated' as OverlayTextMode,
  replyOpen: false,
  locked: true,
  collapsed: false,
  readAloud: false,
  opacity: 0.45,
  geometry: { x: 220, y: 180, width: 520, height: 260 },
  hint: null,
  hotkeys: {
    overlayToggle: 'Alt+Shift+O',
    overlayLock: 'Alt+Shift+P',
    overlayCollapse: 'Alt+Shift+B'
  }
}
const overlaySnap = (): Awaited<ReturnType<WindowApi['overlayReplyState']>> => ({
  ...overlay,
  geometry: { ...overlay.geometry }
})

const sovitsPacks: Awaited<ReturnType<WindowApi['sovitsVoicepacks']>> = [
  {
    id: 'mirana',
    name: '米拉娜',
    version: '15',
    note: '默认音色，引擎装完自动下载',
    defaultPack: true,
    bytes: 268435456,
    haveBytes: 268435456,
    installed: true,
    installedVersion: '15',
    upgradable: false,
    downloading: false,
    progress: 1,
    active: true,
    error: null
  },
  {
    id: 'lina',
    name: '莉娜',
    version: '20',
    note: '高音女声',
    defaultPack: false,
    bytes: 268435456,
    haveBytes: 134217728,
    installed: false,
    installedVersion: null,
    upgradable: true,
    downloading: false,
    progress: 0,
    active: false,
    error: null
  }
]

const sovitsRefs: Awaited<ReturnType<WindowApi['sovitsRefs']>> = [
  {
    name: '米拉娜',
    audio: 'xiaoxiao-seed/xiaoxiao.wav',
    audioPath: 'data/tts/sovits-refs/xiaoxiao-seed/xiaoxiao.wav',
    promptText: '小心，他们可能在打肉山',
    promptLang: 'zh'
  },
  {
    name: '米拉娜（微调）',
    audio: 'mirana/mirana.wav',
    audioPath: 'data/tts/sovits-refs/mirana/mirana.wav',
    promptText: '稳住，我们能赢',
    promptLang: 'zh',
    gptWeights: 'mirana/gpt-e15.ckpt',
    sovitsWeights: 'mirana/sovits-e15.pth',
    gptWeightsPath: 'data/gpt-sovits/weights/mirana/gpt-e15.ckpt',
    sovitsWeightsPath: 'data/gpt-sovits/weights/mirana/sovits-e15.pth'
  }
]

const sovitsStatus: Awaited<ReturnType<WindowApi['sovitsStatus']>> = {
  installed: true,
  archivePresent: false,
  install: { phase: 'ready', progress: 1, error: null },
  server: { phase: 'ready', detail: 'stub api_v2 127.0.0.1:9880', sinceMs: 1000, pid: 4242 },
  home: 'data/gpt-sovits/GPT-SoVITS-v2pro',
  installRoot: 'data/gpt-sovits',
  installHome: 'data/gpt-sovits/GPT-SoVITS-v2pro',
  logs: ['stub: api_v2 ready', 'stub: weights loaded']
}

/** 面板真正调用的通道，逐个给出类型正确的假答复。 */
const implemented = {
  getSettings: async () => settings,
  setSettings: async (patch) => Object.assign(settings, patch),
  testProvider: async () => ({ ok: true, message: 'stub ok', latencyMs: 321 }),
  translationCacheInspect: async () => cacheCounts(),
  translationCacheClear: async () => cacheCounts(),
  translate: async () => '（stub 译文）careful mid',
  getHotkeys: async () => hotkeyPayload(),
  setHotkeys: async (map) => {
    Object.assign(hotkeys, map)
    return hotkeyPayload()
  },
  appVersion: async () => '0.0.0-stub',
  updateCheck: async () => ({ channel: 'stable', status: 'dev', version: '0.0.0' }),
  updateInstall: async () => true,
  onUpdateStatus: (callback) => {
    callback({ channel: 'stable', status: 'dev', version: '0.0.0' })
    return () => {}
  },
  ttsOfflineState: async () => offlineState(),
  ttsOfflineDownload: async () => offlineState(),
  ttsPreview: async () => ({ ok: true }),
  translateInPlace: async () => ({
    ok: true,
    draft: '稳住，我们能赢',
    translated: 'hold mid, we can win',
    grabMs: 120,
    translateMs: 640,
    sendMs: 95,
    restored: true
  }),
  sendReply: async (draft) => ({
    ok: true,
    draft,
    translated: 'hold mid',
    command: 'hold mid'
  }),
  translateReply: async () => ({ ok: true, translated: 'hold mid, we can win', copied: true }),
  captureStatus: async () => ({
    running: true,
    source: 'gsi',
    totalEntries: 37,
    lastTranslateMs: 820,
    lastError: null
  }),
  translatorStatus: async () => ({
    active: true,
    model: 'deepseek-chat',
    conversations: ['prod'],
    lastFallback: null,
    latency: {
      count: 12,
      p50: 820,
      p90: 1900,
      max: 3100,
      session: 12,
      direct: 0,
      timeout: 0,
      error: 0,
      lastSource: 'session',
      lastMs: 820
    }
  }),
  asrStatus: async () => asrState(),
  asrDownload: async () => asrState(),
  whisperProbe: async () => ({ ok: true, configured: true, detail: 'stub 就绪' }),
  whisperSetup: async () => ({
    ok: true,
    binaryPath: 'data/whisper/bin/whisper-cli.exe',
    modelPath: 'data/whisper/models/ggml-small.bin'
  }),
  onWhisperProgress: () => () => {},
  onVoiceChainResult: () => () => {},
  onVoiceRecordState: () => () => {},
  voiceOutTest: async () => ({ ok: true, durationMs: 900, hint: 'stub 声出已播' }),
  overlayVoiceToggle: async () => ({ ok: true }),
  trainOpen: () => {},
  sovitsStatus: async () => sovitsStatus,
  sovitsInstall: async () => sovitsStatus,
  sovitsRefs: async () => sovitsRefs,
  sovitsVoicepacks: async () => sovitsPacks,
  sovitsVoicepackInstall: async () => sovitsPacks,
  sovitsVoicepackDelete: async () => sovitsPacks,
  sovitsSelectPack: async (id) => {
    sovitsPacks.forEach((pack) => {
      pack.active = pack.id === id
    })
    return sovitsPacks
  },
  sovitsSelectRef: async () => true,
  sovitsSeed: async () => true,
  overlayReplyState: async () => overlaySnap(),
  onOverlayState: (callback) => {
    callback(overlaySnap())
    return () => {}
  },
  overlayToggle: async () => {
    overlay.visible = !overlay.visible
    return overlaySnap()
  },
  overlaySetLocked: async (locked) => {
    overlay.locked = locked
    return overlaySnap()
  },
  overlayToggleCollapse: async () => {
    overlay.collapsed = !overlay.collapsed
    return overlaySnap()
  },
  overlayResetGeometry: async () => {
    overlay.geometry = { x: 120, y: 90, width: 520, height: 260 }
    return overlaySnap()
  },
  overlaySetOpacity: async (value) => {
    overlay.opacity = value
    return overlaySnap()
  },
  overlaySetText: async (mode) => {
    overlay.textMode = mode
    return overlaySnap()
  }
} satisfies Partial<WindowApi>

/** 没桩的通道：吵一次，让"这页在预览里点了没反应"变成一条能搜到的日志。 */
function missingChannel(name: string): (...args: unknown[]) => Promise<unknown> {
  let warned = false
  return async () => {
    if (!warned) {
      warned = true
      console.warn(`[panel-preview] window.api.${name} 没有桩：加进 src/renderer/src/preview/api-stub.ts`)
    }
    return {}
  }
}

const api = new Proxy(implemented as unknown as WindowApi, {
  get(target, key) {
    if (key in target) return target[key as keyof WindowApi]
    if (typeof key !== 'string') return undefined
    const handler = missingChannel(key)
    target[key as keyof WindowApi] = handler as never
    return handler
  }
})

window.api = api
// 假设置也挂到 window 上：调试脚本要能读到渲染层正在用的那一份，而不是副本。
window.__panelStubSettings = settings
