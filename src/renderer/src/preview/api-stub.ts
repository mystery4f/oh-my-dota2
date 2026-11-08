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
  panelOpen: false,
  quickPhrases: ['Push mid', 'Fall back', 'Nice play'],
  locked: true,
  collapsed: false,
  readAloud: false,
  opacity: 0.45,
  geometry: { x: 220, y: 180, width: 520, height: 260 },
  hint: null,
  hotkeys: {
    overlayToggle: 'Alt+Shift+O',
    overlayLock: 'Alt+Shift+P',
    overlayCollapse: 'Alt+Shift+B',
    overlayPanel: 'Alt+Shift+H'
  }
}
const overlaySnap = (): Awaited<ReturnType<WindowApi['overlayStatus']>> => ({
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

/**
 * 训练记录：一条正在跑的 ASR、一条已应用的 GV，覆盖列表、指标折线、产物行三种渲染。
 * 时间用相对量，预览里永远像刚跑完。
 */
const stubNow = Date.now()
const stubTrainRuns: Awaited<ReturnType<WindowApi['trainRuns']>> = [
  {
    id: 'asr-ft-stub-running',
    kind: 'asr-ft',
    experiment: '地图-20261108010000',
    params: { epochs: 66, lr: '2e-5', resumeFrom: null },
    data: { files: 38, durationMs: 0, bytes: 412_000 },
    status: 'running',
    startedAt: stubNow - 12 * 60 * 1000,
    endedAt: null,
    artifacts: { runDir: 'data/asr-ft-runs/地图-20261108010000', ckptDir: 'data/asr-ft-runs/地图-20261108010000' },
    metrics: null,
    applied: false,
    error: null
  },
  {
    id: 'gv-sovits-stub-done',
    kind: 'gv-sovits',
    experiment: 'mirana',
    params: { version: 'v2ProPlus', batchSize: 1, epochs: 8, resumeFrom: null },
    data: { files: 0, durationMs: 0, bytes: 0 },
    status: 'applied',
    startedAt: stubNow - 3 * 60 * 60 * 1000,
    endedAt: stubNow - 2 * 60 * 60 * 1000,
    artifacts: { runDir: 'data/gpt-sovits/GPT-SoVITS-v2pro/logs/mirana', voicePack: 'mirana' },
    metrics: {
      steps: 0,
      epochs: 8,
      bestLoss: null,
      lastLoss: null,
      series: Array.from({ length: 8 }, (_, i) => ({ step: i + 1, epoch: i + 1 }))
    },
    applied: true,
    error: null
  }
]
const stubTrainSnapshot: Awaited<ReturnType<WindowApi['trainSnapshot']>> = {
  task: {
    id: 'train-stub',
    kind: 'asr-ft',
    dataset: '地图-20261108010000',
    status: 'running',
    progress: 34,
    stage: 'epoch 22/66',
    startedAt: stubNow - 12 * 60 * 1000,
    endedAt: null,
    inference: 'held'
  },
  logs: [
    { at: stubNow - 60_000, text: 'stub: epoch 21/66 loss=0.412' },
    { at: stubNow - 30_000, text: 'stub: epoch 22/66 loss=0.398' }
  ]
}

/**
 * 训练页的假数据：读稿只放 4 组（逐句 3 组 + 自由说 1 组），录音给 G14 三条，够看清
 * 句号条三态、覆盖率与体检提示，又不至于把预览页撑成一屏滚不到底。
 */
const stubScript = {
  groups: [
    { id: 'G14', title: '对线', mode: 'lines' as const, note: '', lines: [1, 2, 3, 4, 5, 6].map((no) => ({ no, text: `这是 G14 的第 ${no} 句稿子` })) },
    { id: 'G15', title: '团战', mode: 'lines' as const, note: '', lines: [1, 2, 3, 4].map((no) => ({ no, text: `这是 G15 的第 ${no} 句稿子` })) },
    { id: 'G19', title: '报点', mode: 'lines' as const, note: '', lines: [1, 2, 3].map((no) => ({ no, text: `这是 G19 的第 ${no} 句稿子` })) },
    { id: 'G21', title: '自由说', mode: 'free' as const, note: '想到什么说什么', lines: [] }
  ],
  error: null
}
const stubRecs = [1, 2, 3].map((no) => ({
  key: `G14-L${String(no).padStart(2, '0')}`,
  bytes: 62_000 + no * 4000,
  durationMs: 1900 + no * 120,
  mtimeMs: stubNow - no * 86_400_000
}))
const stubGvDatasets = [
  { expName: 'mirana', ready: true, missing: [] },
  { expName: 'windranger', ready: false, missing: ['语义表 6-name2semantic.tsv'] }
]
let stubWebuiRunning = false

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
  panelSuggestions: async () => ({
    ok: true,
    items: ['Heading back to lane', 'Careful, mid is missing', 'Nice play']
  }),
  copyText: async () => true,
  chatHistory: async () => [
    {
      id: 'c1',
      ts: Date.now() - 60000,
      original: '中路不见了',
      translated: 'mid is missing',
      hero: 'muerta'
    }
  ],
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
  asrModels: async () => ({
    activeId: 'qwen3:asr-models/qwen3-asr',
    pinned: true,
    models: [
      { id: 'qwen3:asr-models/qwen3-asr', engineId: 'qwen3', label: 'Qwen3-ASR 0.6B', rel: 'asr-models/qwen3-asr', ready: true, bytes: 986491745, origin: 'download' },
      { id: 'qwen3:asr-models/qwen3-asr.bak', engineId: 'qwen3', label: 'Qwen3-ASR 0.6B（备份）', rel: 'asr-models/qwen3-asr.bak', ready: true, bytes: 986491745, origin: 'backup' },
    ],
  }),
  asrActiveSet: async (id) => ({ activeId: id, pinned: true, models: [] }),
  voiceRuntimeStatus: async () => ({ state: 'ready', nodePath: 'stub-node.exe', installing: false, installError: null }),
  voiceRuntimeInstall: async () => ({ ok: true, error: null }),
  voiceModelRemove: async () => ({ ok: true, error: null }),
  onVoiceRuntimeState: () => () => {},
  onVoiceChainResult: () => () => {},
  onVoiceRecordState: () => () => {},
  voiceOutTest: async () => ({ ok: true, durationMs: 900, hint: 'stub 声出已播' }),
  overlayVoiceToggle: async () => ({ ok: true }),
  trainRuns: async () => stubTrainRuns,
  trainRun: async (id) => stubTrainRuns.find((run) => run.id === id) ?? null,
  trainSnapshot: async () => stubTrainSnapshot,
  trainStart: async () => ({ ok: true, error: null }),
  trainStop: async () => ({ ok: true, error: null }),
  onTrainState: () => () => {},
  trainGvDatasets: async () => stubGvDatasets,
  trainGvWebui: async ({ open }) => {
    stubWebuiRunning = open
    return { ok: true, running: stubWebuiRunning }
  },
  trainGvRegister: async ({ name }) => ({ ok: true, entry: { name } }),
  ftScriptRead: async () => stubScript,
  ftRecList: async () => stubRecs,
  ftRecSave: async (_group, _line, bytes) => ({
    key: `${_group}-${_line}`,
    bytes: bytes.length,
    durationMs: Math.round((bytes.length / 32000) * 1000),
    mtimeMs: Date.now()
  }),
  ftRecDelete: async () => {},
  ftRecRead: async () => new Uint8Array(0),
  ftRecAsr: async () => ({ ok: true, text: '预览里没有真识别引擎' }),
  ftDatasetPrepare: async () => ({
    ok: true,
    trainCount: 38,
    evalCount: 4,
    trainPath: 'data/asr-ft-runs/stub/dataset/train.jsonl',
    evalPath: 'data/asr-ft-runs/stub/dataset/eval.jsonl',
    ledger: [],
    error: null
  }),
  ftAsrftStatus: async () => ({
    env: { ok: true, gaps: [], envRoot: 'data/asr-ft-env' },
    swap: { activeExists: true, bakExists: true, nextExists: false, lastExportDir: 'ft-stub' },
    coverage: { G14: { done: 3, total: 6, stale: 0 }, G15: { done: 1, total: 8, stale: 1 } },
    install: null
  }),
  ftAsrftInstall: async () => ({ running: false, stage: 'done', progress: 1, error: null }),
  ftAsrftApply: async () => ({ ok: true, error: null, model: 'ft-stub' }),
  ftAsrftRollback: async () => ({ ok: true, error: null, model: null }),
  ftAsrftFacts: async () => ({ vramNote: null, resumable: true }),
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
  // #46：预演里给一条「就绪」快照，就能看到中性文字（无按钮）那半边的样子。
  sovitsStartServer: async () => sovitsStatus,
  voiceOutReadiness: async () => ({
    ready: true,
    reason: null,
    line: 'GV 就绪：引擎、音色包、服务、参考音频都在',
    action: null
  }),
  onVoiceOutReadiness: () => () => {},
  overlayStatus: async () => overlaySnap(),
  overlayPanelToggle: async () => {
    overlay.panelOpen = !overlay.panelOpen
    return overlaySnap()
  },
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
