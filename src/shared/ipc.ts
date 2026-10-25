export type ProviderId = 'deepseek' | 'openai' | 'ollama' | 'mimo' | 'custom'

export interface ProviderConfig {
  id: ProviderId
  baseUrl: string
  apiKey: string
  model: string
  /** Auth header style; omitted means the usual "Authorization: Bearer". */
  authStyle?: 'bearer' | 'api-key'
}

export interface ProviderPreset {
  id: ProviderId
  label: string
  baseUrl: string
  model: string
  needsKey: boolean
  authStyle?: 'bearer' | 'api-key'
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    needsKey: true
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    needsKey: true
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    needsKey: false
  },
  {
    id: 'mimo',
    label: 'MiMo (Xiaomi)',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.6-flash',
    needsKey: true,
    authStyle: 'api-key'
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    model: '',
    needsKey: true
  }
]


export type OfflineVoiceId = 'keqing'

export interface OfflineVoice {
  id: OfflineVoiceId
  label: string
  note: string
  speed: number
  pitch: number
  /** 多说话人模型固定用这一个嗓子；单说话人模型为 0。 */
  sid: number
}

/**
 * 本地音色只有一个：刻晴 #70。
 * 多说话人模型靠 sid 选嗓子，这里把 sid 固化成编号而不是留一个滑杆——
 * 用户只会记住「哪个好听」，不会记住 804 个编号里哪个是自己挑的。
 */
export const OFFLINE_VOICES: OfflineVoice[] = [
  { id: 'keqing', label: '刻晴 #70', note: '22.05 kHz，语速偏慢', speed: 0.8, pitch: 1, sid: 70 }
]

export function offlineVoicePreset(id: OfflineVoiceId): OfflineVoice {
  return OFFLINE_VOICES.find((voice) => voice.id === id) ?? OFFLINE_VOICES[0]
}

export interface AppSettings {
  provider: ProviderConfig
  proxyUrl: string
  targetLang: string
  whisperBinPath: string
  ttsOutputDevice: string
  /** 总开关：关掉就只静默记录 GSI 帧，不当聊天处理、不翻译、不上屏。 */
  autoStartCapture: boolean
  /** 直发通道：inplace = 原地替换游戏聊天框（默认），chat = 粘贴并回车发送，console = 控制台 say_team。 */
  sendMode: 'inplace' | 'chat' | 'console'
  /** Dota 控制台开关键（单字符，默认反斜杠）。仅在 sendMode='console' 时使用。 */
  consoleKey: string
  /** In-game nicknames that should never be translated (your own messages). */
  myNicknames: string[]
  replyTone: ReplyTone
  /**
   * 浮层默认点击穿透：它在游戏画面之上，只要吃鼠标就会挡住底下的走位与技能点击。
   * 需要点浮层上的东西（回复条）时，代码会临时关掉它，关掉回复条再恢复。
   */
  /** 浮层显示哪一层文字：默认只显示译文（译文未到时先用原文占位）。 */
  overlayText: OverlayTextMode
  /**
   * 跨语气查账本：这句话在目标语气下没有，就去别的语气找现成译文。
   * 默认开——同一句中文用「客气」发过一次，下次用「简短」发就别再翻一遍。
   */
  crossToneLookup: boolean
  /**
   * 朗读译文：新消息的译文到达时用系统语音念出来（分神时不用一直盯浮层）。
   * 走 Chromium 的 speechSynthesis，全离线、不花 token、不联网。
   */
  ttsReadAloud: boolean
  /** 朗读语速，1 = 正常；超过 2 会听不清，低于 0.6 会跟不上聊天节奏。 */
  ttsRate: number
  /**
   * 朗读音高倍率，1 = 原声。0.9 更沉、1.15 更尖（同一个嗓子听起来是另一个人）。
   * 只在 Edge 引擎上生效——系统嗓子拿不到这个参数。
   */
  ttsPitch: number
  /** 朗读语音名（空 = 按语言自动挑：中文用 zh-CN，其余用 en-US）。 */
  ttsVoice: string
  /**
   * 本地音色预设。Matcha 中文模型只有一个嗓子，所谓「多个音色」只能是
   * 同一嗓子的语速/音高变体——这点得让用户看得见，免得以为是换了模型。
   */
  ttsOfflineVoice: OfflineVoiceId
  /**
   * 朗读引擎：edge = 微软神经语音（好听，需联网，失败自动退回系统嗓子）；
   * system = 本机 speechSynthesis（离线，中文只有「慧慧」一个嗓子）。
   */
  ttsEngine: 'system' | 'edge' | 'offline'
  /** 浮层锁定：位置尺寸冻住 + 强制穿透。想拖动或改大小时先解锁。 */
  overlayLocked: boolean
  /** 每行底色不透明度（0.05–0.9）：游戏画面亮的时候要淡，暗图要深一点才看得清。 */
  overlayOpacity: number
  /** 用户调过的浮层几何；null = 跟随捕获区域自动摆放。 */
  overlayBounds: OverlayGeometry | null
}

export const DEFAULT_SETTINGS: AppSettings = {
  provider: {
    id: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat'
  },
  proxyUrl: '',
  targetLang: 'zh-CN',
  whisperBinPath: '',
  ttsOutputDevice: '',
  autoStartCapture: true,
  sendMode: 'inplace',
  consoleKey: '\\',
  myNicknames: [],
  replyTone: 'terse',
  overlayText: 'translated',
  crossToneLookup: true,
  ttsReadAloud: false,
  ttsRate: 1,
  ttsPitch: 1,
  ttsVoice: '',
  ttsOfflineVoice: 'keqing',
  ttsEngine: 'edge',
  overlayLocked: true,
  overlayOpacity: 0.34,
  overlayBounds: null
}

export type TranslateDirection = 'en-zh' | 'zh-en' | 'auto-zh'

/** 回复英译语气：越短越省事，玩家在游戏里没空读长句。 */
export type ReplyTone = 'terse' | 'polite' | 'hurry' | 'firm'

/**
 * 浮层显示哪一层文字。默认 `translated`：译文到达前先占位显示原文（压暗 + 「翻译中…」），
 * 到达后就地换掉 —— 任何时刻都不会有「空白等翻译」的行。
 */
export type OverlayTextMode = 'translated' | 'both' | 'original'

export interface TestResult {
  ok: boolean
  message: string
  latencyMs?: number
}

/** 一条待朗读的译文：语言决定挑哪套系统语音，rate/voice 跟着设置走。 */
export interface SpeakPayload {
  text: string
  lang: 'zh' | 'en'
  rate: number
  /** 音高倍率，1 = 原声。 */
  pitch: number
  voice: string
  /** edge / offline：需要 audio 才出声；system：用 text 走系统嗓子。 */
  engine?: 'system' | 'edge' | 'offline'
  /** 合成好的音频（base64）。edge 是 mp3，offline 是 wav；为空表示这句合成失败。 */
  audio?: string
  /** audio 的 MIME，缺省按 audio/mpeg 处理。 */
  audioMime?: string
}

/** One deduped chat line pushed to the overlay / dashboard stream. */
/** 词库统计：面板上那行「N 对 · 命中 M 次」读的就是它。 */
/**
 * 更新的对外状态机。面板只认这几个值，不去猜 electron-updater 的内部事件名。
 * `dev` 是「开发模式不检查」，不是错误——别把它染成红色。
 */
export interface UpdateState {
  /** 这条包属于哪条更新线：Nightly 包只跟 Nightly，正式包只跟正式版。 */
  channel: 'nightly' | 'stable'
  status: 'idle' | 'checking' | 'downloading' | 'ready' | 'none' | 'error' | 'dev'
  version: string
  percent?: number
  message?: string
}

export interface CacheStats {
  pairs: number
  hits: number
  hitRatio: number
  origins: Record<string, number>
}

export interface CaptureEntry {
  id: string
  ts: number
  original: string
  translated: string | null
  /** 原文已推送、译文还在路上——渲染层先显示原文，译文到达后就地替换。 */
  pending?: boolean
  /** 说话人的英雄短名（`nevermore`），渲染层用它换成头像；签名等行没有。 */
  hero?: string
  /** 译文直接来自翻译记账本（没调模型）——渲染层标个「词」字，方便判断是不是现翻的。 */
  cached?: boolean
  /** 来自「我」的消息（GSI 的 own）：照常上屏，但朗读要跳过——自己刚打完，不必再念一遍。 */
  own?: boolean
  /** 说话人英雄名（GSI 提供）：朗读时念成「英雄 说 ……」。 */
  speaker?: string
  /** 这行进了翻译队列却没翻成（服务不可达、鉴权失败…）：渲染层要显示出来，不能假装还在翻。 */
  error?: string
}

/** 回复直发结果：draft = 输入的中文，translated = 英文，command = 实际下发的控制台命令。 */
export interface ReplySendResult {
  ok: boolean
  draft: string
  translated: string | null
  command: string | null
  error?: string
}

/** 原地替换结果：draft = 从游戏聊天框读到的中文，translated = 写回聊天框的英文。 */
export interface InPlaceResult {
  ok: boolean
  draft: string | null
  translated: string | null
  /** 各阶段耗时（毫秒）：慢在读聊天框、翻译还是写回，看一眼就知道。 */
  grabMs?: number
  translateMs?: number
  sendMs?: number
  error?: string
}

/**
 * Dota 2 Game State Integration 的运行状态。
 * 它只是状态源（GSI 里没有聊天正文）：用来判断「在不在对局里」，正文仍然靠屏幕 OCR。
 */
export interface GsiStatusView {
  listening: boolean
  port: number
  /** 最近一次推送里的 `map.game_state`，null = 还没收到过。 */
  gameState: string | null
  matchId: string | null
  lastAt: number | null
  /** 由 GSI 自动开/停捕获的次数，排查「自己开起来的」用。 */
  autoStarts: number
  autoStops: number
  /** 写进 Dota 的 cfg 路径，找不到游戏目录时为 null。 */
  configPath: string | null
  configError: string | null
  /** 本局阵容（我方在前）：来自 cfg 的 `allplayers`，训练场/主菜单时为空。 */
  roster: { slot: number; name: string; hero: string; side: 'mine' | 'enemy' | 'unknown' }[]
  /** 阵容的一句话概括，空阵容是空串，面板直接用。 */
  rosterText: string
}

export interface CaptureStatus {
  running: boolean
  /** 正文来源固定是 GSI：抓屏 OCR 链路已整体移除。 */
  source: 'gsi'
  totalEntries: number
  lastTranslateMs: number | null
  /** GSI 状态源（主进程启动本地监听后才有）。 */
  gsi?: GsiStatusView
  lastError: string | null
}

/** 翻译延迟分布：服务端首字节能从 1.3s 抖到 31s，单次数字没有意义，分位数才有。 */
export interface TranslationLatency {
  count: number
  p50: number | null
  p90: number | null
  max: number | null
  session: number
  direct: number
  timeout: number
  error: number
  lastSource: 'session' | 'direct' | 'timeout' | 'error' | null
  lastMs: number | null
}

/** session:status 的渲染层视图。 */
export interface TranslatorStatus {
  active: boolean
  model: string | null
  conversations: string[]
  lastFallback: string | null
  latency: TranslationLatency
}

/** M4 skeleton: whether a voice helper binary is configured and reachable. */
export interface VoiceBackendStatus {
  configured: boolean
  path: string
  exists: boolean
}

/** Result of probing / previewing a voice helper (whisper.cpp, edge-tts). */
/** Progress of the whisper binary/model download. */
export interface VoiceAssetProgress {
  phase: 'binary' | 'model'
  pct: number
}

/** Outcome of ensuring the whisper binary and model are on disk. */
export interface VoiceAssetsResult {
  ok: boolean
  binaryPath: string | null
  modelPath: string | null
  downloadedBin?: boolean
  downloadedModel?: boolean
  error?: string
}

/** Result of an Edge TTS preview; audio is returned as base64 mp3 for the renderer. */
export interface VoicePreviewResult {
  ok: boolean
  audioBase64?: string
  voice?: string
  error?: string
}

/** Outcome of a whisper transcription. */
export interface VoiceTranscribeResult {
  ok: boolean
  text: string
  error?: string
}
export interface VoiceProbeResult {
  ok: boolean
  configured: boolean
  detail?: string
  note?: string
  error?: string
}

export interface OverlayStatus {
  visible: boolean
  /** 浮层显示什么：只译文（默认）／原文+译文／只原文。 */
  textMode: OverlayTextMode
  replyOpen: boolean
  /** 锁定后位置与尺寸都冻住，并且强制点击穿透——想调整时先解锁。 */
  locked: boolean
  /** 收起成小图标：此时窗口很小，但仍然可点（否则展不开）。 */
  collapsed: boolean
  /** 朗读开关的当前状态。 */
  readAloud: boolean
  opacity: number
  /** 浮层当前的实际几何（DIP），面板拿它显示，拖拽拿它算增量。 */
  geometry: OverlayGeometry
  /** 为什么取不到字（null = 一切正常）——只在异常时显示，正常时整块保持干净。 */
  hint: string | null
}

/** 浮层的位置与尺寸，全部是 DIP（和 `screen` 报的是同一套坐标）。 */
export interface OverlayGeometry {
  x: number
  y: number
  width: number
  height: number
}

/** Result of the reply flow: translate zh→en and copy to clipboard. */
export interface ReplyResult {
  ok: boolean
  translated: string | null
  copied: boolean
  error?: string
}

export const IPC = {
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  PROVIDER_TEST: 'provider:test',
  PROVIDER_TRANSLATE: 'provider:translate',
  CAPTURE_START: 'capture:start',
  CAPTURE_STOP: 'capture:stop',
  CAPTURE_STATUS: 'capture:status',
  /** 手动触发一次「拍屏 → OCR → 翻译 → 重建译文框」。 */
  /** 手动模式整屏重建（渲染层先清空再填充）。 */
  CAPTURE_REPLACE: 'capture:replace',
  /** 中文草稿 → 翻译 → 控制台 say_team 直发。 */
  REPLY_SEND: 'reply:send',
  /** 读取游戏聊天框草稿 → 翻译 → 原地替换成英文（不发送）。 */
  REPLY_INPLACE: 'reply:inplace',
  CAPTURE_ENTRIES: 'capture:entries',
  CACHE_STATS: 'cache:stats',
  UPDATE_CHECK: 'update:check',
  APP_VERSION: 'app:version',
  UPDATE_INSTALL: 'update:install',
  UPDATE_STATUS: 'update:status',
  CAPTURE_UPDATE: 'capture:update',
  STREAM_INIT: 'stream:init',
  STREAM_GRAB: 'stream:grab',
  STREAM_HELLO: 'stream:hello',
  STREAM_READY: 'stream:ready',
  STREAM_FRAME: 'stream:frame',
  SESSION_STATUS: 'session:status',
  REPLY_TRANSLATE: 'reply:translate',
  VOICE_WHISPER_PROBE: 'voice:whisper-probe',
  VOICE_WHISPER_SETUP: 'voice:whisper-setup',
  VOICE_WHISPER_PROGRESS: 'voice:whisper-progress',
  VOICE_TRANSCRIBE: 'voice:transcribe',
  VOICE_RECORD_TOGGLE: 'voice:record-toggle',
  VOICE_TTS_PREVIEW: 'voice:tts-preview',
  OVERLAY_TOGGLE: 'overlay:toggle',
  OVERLAY_REPLY: 'overlay:reply',
  OVERLAY_REPLY_OPEN: 'overlay:reply-open',
  OVERLAY_REPLY_CLOSE: 'overlay:reply-close',
  OVERLAY_REPLY_STATE: 'overlay:reply-state',
  OVERLAY_TEXT: 'overlay:text',
  VOICE_SPEAK: 'voice:speak',
  TTS_OFFLINE_STATE: 'tts:offline-state',
  TTS_OFFLINE_DOWNLOAD: 'tts:offline-download',
  OVERLAY_GEOMETRY: 'overlay:geometry',
  OVERLAY_GEOMETRY_RESET: 'overlay:geometry-reset',
  OVERLAY_VOICE: 'overlay:voice',
  OVERLAY_COLLAPSE: 'overlay:collapse',
  OVERLAY_KEEPALIVE: 'overlay:keepalive',
  OVERLAY_NUDGE: 'overlay:nudge',
  OVERLAY_SNAP: 'overlay:snap',
  OVERLAY_LOCK: 'overlay:lock',
  OVERLAY_OPACITY: 'overlay:opacity',
  OVERLAY_STATE: 'overlay:state'
} as const

/** Contract exposed on window.api by the preload bridge. */
/** 离线朗读引擎（sherpa-onnx + Matcha）的安装状态。 */
export interface OfflineStatus {
  /** 本机是否有可用的 node.exe：sherpa 原生插件在 Electron 里跑不了（N-API 外部缓冲被禁）。 */
  available: boolean
  ready: boolean
  bytes: number
  dir: string
  downloading: boolean
  /** 0–1；拿不到 Content-Length 时会停在 0。 */
  progress: number
  error: string | null
}

export interface WindowApi {
  getSettings(): Promise<AppSettings>
  setSettings(patch: Partial<AppSettings>): Promise<AppSettings>
  testProvider(provider: ProviderConfig): Promise<TestResult>
  translate(text: string, direction?: TranslateDirection): Promise<string>
  translateReply(text: string, tone?: ReplyTone): Promise<ReplyResult>
  whisperProbe(binPath: string): Promise<VoiceProbeResult>
  whisperSetup(): Promise<VoiceAssetsResult>
  onWhisperProgress(callback: (progress: VoiceAssetProgress) => void): () => void
  /** Synthesize speech with the Edge neural TTS service and return mp3 bytes for playback. */
  transcribeAudio(wavBase64: string, language?: string): Promise<VoiceTranscribeResult>
  onVoiceRecordToggle(callback: () => void): () => void
  ttsPreview(text: string): Promise<VoicePreviewResult>
  /** 离线朗读模型的安装状态（是否就绪、占用多少磁盘、是否正在下载）。 */
  ttsOfflineState(): Promise<OfflineStatus>
  /** 触发（或继续）一次离线模型下载；返回最新状态。 */
  ttsOfflineDownload(): Promise<OfflineStatus>
  captureStart(): Promise<CaptureStatus>
  captureStop(): Promise<CaptureStatus>
  captureStatus(): Promise<CaptureStatus>
  translatorStatus(): Promise<TranslatorStatus>
  onCaptureEntries(callback: (entries: CaptureEntry[]) => void): () => void
  onCaptureUpdate(callback: (entries: CaptureEntry[]) => void): () => void
  /** 记账本的汇总数字（词库对数、命中次数、命中比）。 */
  cacheStats(): Promise<CacheStats>
  appVersion(): Promise<string>
  updateCheck(): Promise<UpdateState>
  updateInstall(): Promise<boolean>
  onUpdateStatus(callback: (state: UpdateState) => void): () => void
  onCaptureReplace(callback: (entries: CaptureEntry[]) => void): () => void
  sendReply(text: string): Promise<ReplySendResult>
  translateInPlace(): Promise<InPlaceResult>
  overlayToggle(): Promise<OverlayStatus>
  overlaySetText(mode: OverlayTextMode): Promise<OverlayStatus>
  overlayOpenReply(): Promise<OverlayStatus>
  overlayCloseReply(submitted?: boolean): Promise<OverlayStatus>
  overlayReplyState(): Promise<OverlayStatus>
  onOverlayReply(callback: (open: boolean) => void): () => void
  onOverlayState(callback: (state: OverlayStatus) => void): () => void
  /** 主进程决定「这一句该念」，浮层只负责发声（speechSynthesis 在渲染进程）。 */
  onVoiceSpeak(callback: (payload: SpeakPayload) => void): () => void
  /** 拖动/拉伸浮层时提交新几何（只传要改的字段）。 */
  overlaySetGeometry(patch: Partial<OverlayGeometry>): Promise<OverlayStatus>
  /** 还原浮层：回到跟随捕获区域的默认位置与尺寸。 */
  overlayResetGeometry(): Promise<OverlayStatus>
  overlaySetVoice(read: boolean): Promise<OverlayStatus>
  overlayToggleCollapse(): Promise<OverlayStatus>
  overlayKeepAlive(): Promise<void>
  overlayNudge(dx: number, dy: number): Promise<OverlayStatus>
  overlaySnap(): Promise<OverlayStatus>
  /** 锁定/解锁浮层：解锁才能拖，锁定时强制穿透。 */
  overlaySetLocked(locked: boolean): Promise<OverlayStatus>
  overlaySetOpacity(value: number): Promise<OverlayStatus>
  /** 常驻隐藏窗口里的桌面视频流（抓屏专用，不走 dashboard）。 */
  screenStream: ScreenStreamApi
}

/** 物理像素裁切矩形（相对显示器左上角）。 */
export interface StreamRect {
  x: number
  y: number
  width: number
  height: number
}

/** 抓屏流桥：主进程要一帧 → 隐藏窗口从视频流裁切 → 回传 PNG base64。 */
export interface ScreenStreamApi {
  onInit(callback: (payload: { sourceId: string }) => void): () => void
  onGrab(callback: (payload: { requestId: number; rect: StreamRect }) => void): () => void
  /** 页面脚本就绪（可以接收 onGrab / onInit）。 */
  reportHello(): void
  reportReady(): void
  reportFrame(requestId: number, pngBase64: string | null, error?: string): void
}
