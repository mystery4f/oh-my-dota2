import type { VoiceReplyStage } from './voice-out'

import type {
  AsrFtInstallState,
  AsrFtStatusResult,
  AsrFtSwapResult,
  FtDatasetPrepareResult,
  TrainSnapshot,
  TrainStartRequest,
  TrainStartResult
} from '@shared/train'


/** ASR 微调读稿：一句原文。 */
export interface FtScriptLine {
  no: number
  text: string
}

/** ASR 微调读稿：一组（lines 模式逐句录，free 模式自由说）。 */
export interface FtScriptGroup {
  id: string
  title: string
  mode: 'lines' | 'free'
  lines: FtScriptLine[]
  note: string
}

/** 读稿解析结果：error 非空表示内置资源缺失/解析失败。 */
export interface FtScriptState {
  groups: FtScriptGroup[]
  error: string | null
}

/** 一条录音：key 形如 G01-L03（free 组是 G21-T01），durationMs 由 16k mono wav 字节数推算。 */
export interface FtRecInfo {
  key: string
  bytes: number
  durationMs: number
}
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


export type OfflineVoiceId = 'baker' | 'xiao_ya' | 'eula'
export type VoiceOutEngine = 'edge' | 'offline' | 'sovits'

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
/**
 * 本地音色留下这三个（用户钦定后又裁掉 melo，2026-10-25）：
 * - baker：Matcha icefall，22.05 kHz，最快（200 ms 级），声音闷一点但最跟得上节奏。
 * - xiao_ya：piper 小雅，22.05 kHz，包最小（60 MB），音色偏温柔。
 * - eula：hf 角色微调，22.05 kHz，804 个说话人，sid 挑嗓子。
 * 名字给人的错觉要说清：eula/baker 这些是「训练目标」，不代表听感；听感由模型 + sid 决定。
 * melo（44.1 kHz 中英混读）曾入选，因延迟最高（~0.5 s）被移除，模型目录可整目录删掉。
 */
export const OFFLINE_VOICES: OfflineVoice[] = [
  { id: 'baker', label: 'Baker（最快）', note: '22.05 kHz，200 ms 级', speed: 1, pitch: 1, sid: 0 },
  { id: 'xiao_ya', label: '小雅', note: '22.05 kHz，包最小', speed: 1, pitch: 1, sid: 0 },
  { id: 'eula', label: 'Eula #5', note: '22.05 kHz，804 人表', speed: 1, pitch: 1, sid: 5 }
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
  /**
   * 声出引擎：edge = 英文神经嗓占位（默认）；offline = 本地离线模型（中文嗓，念英文吞字）；
   * sovits = GV（GPT-SoVITS）音色包——音色由参考音频决定，权重切换走现有音色包管线。
   */
  ttsOutEngine: VoiceOutEngine
  /** 声出音色：edge 存声出清单里的英文嗓 id，offline 存离线清单里的本地嗓 id；GV 不用（空串）。 */
  ttsOutVoice: string
  /**
   * 说话键（push-to-talk）：游戏内按住才发言的按键，F1–F12 或单个字母/数字。
   * 声出期间由应用自动按下/松开（合成成功才按，头尾各留 200ms 余量）；乱填打回 F5。
   */
  ttsSpeakKey: string
  /** 测试模式：开了只放音频到所选输出设备、不模拟按下说话键——游戏没开也能全链路试听，F5 不会落到别的窗口上。 */
  voiceOutTestMode: boolean
  /** 只看识别（测试用）：转写完就停——不翻译、不进剪贴板、不声出不按键。测口音/调模型用。 */
  /** 只看识别（测试用）：转写完就停——不翻译、不进剪贴板、不声出不按键。测口音/调模型用。 */
  voiceTranscribeOnly: boolean
  /**
   * 语音识别引擎：whisper（本地 whisper.cpp，ggml-small）或 qwen3（Qwen3-ASR 0.6B，
   * 方言/抗噪更强、自带标点，模型 ~980MB；唯一支持热词的引擎）。
   */
  asrEngine: 'whisper' | 'qwen3'
  /** 热词表（逗号/顿号分隔），仅 Qwen3 引擎注入；纠错回路自动追加，也可手编。 */
  /** 热词表（逗号/顿号分隔），仅 Qwen3 引擎注入；纠错回路自动追加，也可手编。 */
  asrHotwords: string
  /** 训练窗口记住的任务类型：demo 演示任务；gv-gpt/gv-sovits/asr-ft 在 T3/T5 接入。 */
  trainKind: 'demo' | 'asr-ft' | 'gv-gpt' | 'gv-sovits'
  /** 训练窗口记住的数据集标识（T3 起是登记名，现在只是记下来下次自动填）。 */
  /** 训练窗口记住的数据集标识（T3 起是登记名，现在只是记下来下次自动填）。 */
  trainDataset: string
  /** ASR 微调环境根目录：空 = 用应用数据目录里的 asr-ft-env；手动搭的环境（试点那套）填根路径。 */
  asrFtEnvDir: string
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
  /**
   * 自己也念：默认关。自己刚打完的字不必再听一遍，而且真对局里自己那句「::」
   * 会被念成「司夜刺客说，」紧接敌方的「基地」，听成「司夜刺客说基地」。
   * 想核对发音、或单人练英雄时打开它。
   */
  ttsReadOwn: boolean
  /**
   * 丢弃积压：默认开。GPT-SoVITS 在本机显卡上推理，游戏正吃满显卡时一句要 5–7 s，
   * 聊天刷屏时排队会把显卡按住几十秒——游戏掉帧、读到的也是过时的旧消息。
   * 开启后同一时刻只保留最新一条待读，被顶掉的直接跳过（日志 TTS_SPEAK_DROP）。
   * 关掉它就恢复「每条都念」的完整回放。
   */
  ttsDropBacklog: boolean
  /**
   * 「某某说」前缀念不念、念在哪头。默认 front（「影魔说，中路没人」）；
   * back = 内容在前（「中路没人，影魔说」）；off = 只念内容。
   */
  ttsSpeakPrefix: 'front' | 'back' | 'off'
  /**
   * 长句切段上限（字）：朗读前按标点把长句切成不超过这个长度的小段，第一段先出声，
   * 其余段边播边合成。太小断句碎，太大每段等得久；10–60，默认 30。
   */
  ttsSpeakSegmentChars: number
  /**
   * 说话人怎么念，连标点一起整句模板化：{who}=说话人（我/影魔/玩家9），{body}=内容。
   * 两条各自管一头；没有 {body} 的模板视同没配（loadSettings 打回缺省）。
   */
  ttsSpeakFrontTpl: string
  ttsSpeakBackTpl: string
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
 * system = 本机 speechSynthesis（离线，中文只有「慧慧」一个嗓子）；
 * sovits = GPT-SoVITS 本地服务（需另起整合包的 api_v2，服务不在就不出声，绝不回退）。
   */
  ttsEngine: 'system' | 'edge' | 'offline' | 'sovits'
  /** GPT-SoVITS api_v2 服务地址（整合包 runtime 起，默认 127.0.0.1:9880）。 */
  ttsSovitsUrl: string
  /** 参考音频绝对路径（api_v2 在服务端磁盘上读这个文件；同机部署就是本机路径）。 */
  ttsSovitsRefAudio: string
  /** 参考音频的逐字转写：转写和音频对不上，克隆音质会明显劣化。 */
  ttsSovitsPromptText: string
  /** 参考音频转写的语言（zh/en）：零样本克隆按转写语言对齐，英文参考必须配 en。 */
  ttsSovitsPromptLang: 'zh' | 'en'
  /** 整合包安装目录；填了就由应用自动拉起 api_v2，留空用数据目录的 gpt-sovits 自装位。 */
  ttsSovitsHome: string
  /** 浮层锁定：位置尺寸冻住 + 强制穿透。想拖动或改大小时先解锁。 */
  overlayLocked: boolean
  /** 上次退出时浮层是收起的小图标还是整块；启动时照此还原（2026-10-28「记忆收起」）。 */
  overlayCollapsed: boolean
  /** 上次退出时浮层是显示还是被 Alt+Shift+O 藏了；启动时照此还原（「记忆隐藏」）。 */
  overlayVisible: boolean
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
  ttsSpeakKey: 'F5',
  voiceOutTestMode: false,
  voiceTranscribeOnly: false,
  asrEngine: 'whisper',
  trainKind: 'demo',
  trainDataset: '',
  asrFtEnvDir: '',
  asrHotwords: '',
  ttsOutEngine: 'edge',
  ttsOutVoice: '',
  autoStartCapture: true,
  sendMode: 'inplace',
  consoleKey: '\\',
  myNicknames: [],
  replyTone: 'terse',
  overlayText: 'translated',
  crossToneLookup: true,
  ttsReadAloud: false,
  ttsReadOwn: false,
  ttsDropBacklog: true,
  ttsSpeakPrefix: 'front',
  ttsSpeakSegmentChars: 30,
  ttsSpeakFrontTpl: '{who}说，{body}',
  ttsSpeakBackTpl: '{body}，{who}表示',
  ttsRate: 1,
  ttsPitch: 1,
  ttsVoice: '',
  ttsOfflineVoice: 'baker',
  ttsEngine: 'edge',
  ttsSovitsUrl: 'http://127.0.0.1:9880',
  ttsSovitsRefAudio: '',
  ttsSovitsPromptText: '',
  ttsSovitsPromptLang: 'zh',
  ttsSovitsHome: '',
  overlayLocked: true,
  overlayCollapsed: false,
  overlayVisible: false,
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
  /** 捕获时间戳（ms）。投递层/浮层拿它判过期：更新的消息已到，旧的待念直接作废。 */
  ts?: number
  lang: 'zh' | 'en'
  rate: number
  /** 音高倍率，1 = 原声。 */
  pitch: number
  voice: string
  /** edge / offline / sovits：需要 audio 才出声；system：用 text 走系统嗓子。 */
  engine?: 'system' | 'edge' | 'offline' | 'sovits'
  /** 合成好的音频（base64）。edge 是 mp3，offline / sovits 是 wav；为空表示这句合成失败。 */
  audio?: string
  /** audio 的 MIME，缺省按 audio/mpeg 处理。 */
  audioMime?: string
}

/** 「测试声出」按钮的结果：念没念成、念了多久、有没有要给用户看的提示。 */
export interface VoiceOutTestResult {
  ok: boolean
  /** 实际播放时长（毫秒）；没播出来为 null。 */
  durationMs: number | null
  /** 输出设备回退等提示；无提示为 null。 */
  hint: string | null
  /** 说话键按下/松开失败的说明（播放照常进行，只是频道没开）。 */
  keyError?: string
  /** 整体失败原因（合成失败 / 窗口超时等）。 */
  error?: string
}

/** 主进程 → 声出窗口：播这段音频，并按 requestedDevice 选输出。 */
export interface VoiceOutPlayRequest {
  requestId: number
  audioBase64: string
  audioMime: string
  requestedDevice: string
}

/** 声出窗口 → 主进程：元数据就绪（时长已知、setSinkId 已生效，可以开按说话键了）。 */
export interface VoiceOutReadyReport {
  requestId: number
  ok: boolean
  durationMs: number | null
  sinkId: string
  sinkLabel: string
  fallback: boolean
  hint: string | null
  error?: string
}

/** 声出窗口 → 主进程：播放结束/失败；主进程据此松开说话键。 */
export interface VoiceOutEndedReport {
  requestId: number
  ok: boolean
  durationMs: number | null
  error?: string
}

/** 语音对讲一键到底（票 05）的结果：译文 + 播没播出 + 停在哪一环。 */
export interface VoiceReplyResult {
  /** 译文（已 trim，可直接进剪贴板/频道）；翻译这环就失败了为 null。 */
  translated: string | null
  /** 音频完整播出且说话键全程按住（队友真能听见）。 */
  spoken: boolean
  /** 失败停在哪一环：识别/翻译/声出；成功为 null。 */
  stage: VoiceReplyStage | null
  /** 失败说明；成功为 null。 */
  error: string | null
}

/** 语音链在面板上的回显：一条摘要覆盖 成功 / 某环失败 / 压根没识别到话。 */
export interface VoiceChainSummary {
  /** 识别到的原文；没识别到为空串。 */
  transcript: string
  /** 译文；翻译失败为 null。 */
  translated: string | null
  /** 声出是否完整播出。 */
  spoken: boolean
  /** 失败停在哪一环；成功为 null。 */
  stage: VoiceReplyStage | null
  /** 失败说明；成功为 null。 */
  error: string | null
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

/** Result of a TTS preview; audio is base64 (edge=mp3, sovits=wav) for the renderer. */
export interface VoicePreviewResult {
  ok: boolean
  audioBase64?: string
  voice?: string
  /** 音频 MIME；缺省按 audio/mp3 处理（Edge）。sovits 回 audio/wav。 */
  audioMime?: string
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
  SESSION_STATUS: 'session:status',
  REPLY_TRANSLATE: 'reply:translate',
  VOICE_WHISPER_PROBE: 'voice:whisper-probe',
  VOICE_WHISPER_SETUP: 'voice:whisper-setup',
  VOICE_WHISPER_PROGRESS: 'voice:whisper-progress',
  VOICE_TRANSCRIBE: 'voice:transcribe',
  // 语音链状态回显：overlay 起录/停录/出结果时报给主进程，主进程广播给面板。
  OVERLAY_VOICE_STATE: 'overlay:voice-record-state',
  OVERLAY_VOICE_RESULT: 'overlay:voice-chain-result',
  VOICE_RECORD_STATE: 'voice:record-state',
  VOICE_CHAIN_RESULT: 'voice:chain-result',
  VOICE_REPLY: 'voice:reply',
  VOICE_RECORD_TOGGLE: 'voice:record-toggle',
  VOICE_TTS_PREVIEW: 'voice:tts-preview',
  VOICE_OUT_TEST: 'voice-out:test',
  VOICE_OUT_PLAY: 'voice-out:play',
  VOICE_OUT_START: 'voice-out:start',
  VOICE_OUT_READY: 'voice-out:ready',
  VOICE_OUT_ENDED: 'voice-out:ended',
  OVERLAY_TOGGLE: 'overlay:toggle',
  OVERLAY_VOICE_TOGGLE: 'overlay:voice-record-toggle',
  OVERLAY_REPLY: 'overlay:reply',
  OVERLAY_REPLY_OPEN: 'overlay:reply-open',
  OVERLAY_REPLY_CLOSE: 'overlay:reply-close',
  OVERLAY_REPLY_STATE: 'overlay:reply-state',
  OVERLAY_TEXT: 'overlay:text',
  VOICE_SPEAK: 'voice:speak',
  TTS_OFFLINE_STATE: 'tts:offline-state',
  TTS_OFFLINE_DOWNLOAD: 'tts:offline-download',
  // 识别模型（Qwen3）状态与解压：和离线朗读同一套「状态 + 获取」面板节奏。
  ASR_STATUS: 'asr:status',
  ASR_DOWNLOAD: 'asr:download',
  // 训练管理（T1：窗口骨架 + 任务模型；真实训练栈 T3/T5 接入）。
  TRAIN_OPEN: 'train:open',
  TRAIN_START: 'train:start',
  TRAIN_STOP: 'train:stop',
  TRAIN_SNAPSHOT: 'train:snapshot',
  /** 主进程广播训练快照（任务状态 + 日志尾），训练窗口订阅。 */
  TRAIN_STATE: 'train:state',
  // ASR 微调录音（T4a）：内置读稿 + 录音存取，全部落在应用数据目录 asr-ft/ 下。
  FT_SCRIPT_READ: 'ft:script-read',
  FT_REC_LIST: 'ft:rec-list',
  FT_REC_SAVE: 'ft:rec-save',
  FT_REC_DELETE: 'ft:rec-delete',
  FT_REC_READ: 'ft:rec-read',
  FT_REC_ASR: 'ft:rec-asr',
  FT_DATASET_PREPARE: 'ft:dataset-prepare',
  // ASR 微调闭环（T5）：环境状态 / 换模 / 回滚，训练+导出走 TRAIN_START/STOP。
  FT_ASRFT_STATUS: 'ft:asrft-status',
  FT_ASRFT_APPLY: 'ft:asrft-apply',
  FT_ASRFT_ROLLBACK: 'ft:asrft-rollback',
  FT_ASRFT_INSTALL: 'ft:asrft-install',
  TTS_SOVITS_STATUS: 'tts:sovits-status',
  TTS_SOVITS_INSTALL: 'tts:sovits-install',
  TTS_SOVITS_REFS: 'tts:sovits-refs',
  TTS_SOVITS_VOICEPACKS: 'tts:sovits-voicepacks',
  TTS_SOVITS_VOICEPACK_INSTALL: 'tts:sovits-voicepack-install',
  TTS_SOVITS_VOICEPACK_DELETE: 'tts:sovits-voicepack-delete',
  TTS_SOVITS_SELECT_REF: 'tts:sovits-select-ref',
  TTS_SOVITS_SEED: 'tts:sovits-seed',
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

/** Qwen3-ASR 模型包（GitHub release，~838MB）；国内网络建议浏览器手动下载。 */
export const QWEN3_ASR_RELEASE_URL =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25.tar.bz2'


/** GPT-SoVITS：引擎包安装状态 + api_v2 服务状态 + 最近日志（面板一眼看出「起没起来」）。 */
export interface SovitsStatus {
  /** 引擎包是否已就位（runtime/python.exe + api_v2.py 都在）。 */
  installed: boolean
  /** 手动放进去的 8GB 压缩包是否在（用户自己下载后丢进数据目录即可）。 */
  archivePresent: boolean
  install: {
    phase: 'idle' | 'downloading' | 'extracting' | 'ready' | 'error'
    progress: number
    error: string | null
  }
  /** 服务状态机：off 没起 / starting 拉模型中 / ready 应用托管运行 / external 复用外部实例。 */
  server: {
    phase: 'off' | 'starting' | 'ready' | 'external'
    detail: string
    sinceMs: number
    pid: number | null
  }
  /** 实际用的引擎包目录（配置 > 应用自装位；两处都没有就是空串，不猜别处的手工安装）。 */
  home: string
  /** 数据目录下这一层的路径：手动安装时告诉用户压缩包该放哪。 */
  installRoot: string
  /** 自装位下引擎包的完整路径（installRoot + 包目录名）：面板 placeholder 按环境现算现显示。 */
  installHome: string
  /** 最近若干行日志（旧→新），面板折叠框直接展示。 */
  logs: string[]
}

/** 晓晓保底参考在 refs 库里的子目录名（渲染层判断「保底条目在不在」用）。 */
export const SOVITS_SEED_REF_DIR = 'xiaoxiao-seed'
/** 参考音频库（<数据根>/tts/sovits-refs/）里的一条：下拉框选一下就把参考整套换掉。 */
export interface SovitsRefEntry {
  /** 下拉框显示的名字，如「米拉娜」。 */
  name: string
  /** refs.json 里写的库内相对路径（POSIX 风格，含音色子目录）。 */
  audio: string
  /** 解析后的音频绝对路径：渲染层拿它填进参考路径框，服务端按它读文件。 */
  audioPath: string
  /** 参考音频的逐字转写。 */
  promptText: string
  /** 转写的语言：克隆时按它对齐。 */
  promptLang: 'zh' | 'en'
  /** 微调权重（可选）：GPT ckpt 相对 <数据根>/gpt-sovits/weights/ 的 POSIX 路径，与 sovitsWeights 成对。 */
  gptWeights?: string
  /** 微调权重（可选）：SoVITS pth 相对路径，与 gptWeights 成对。 */
  sovitsWeights?: string
  /** 解析后的权重绝对路径：主进程切权重时直接喂给 api_v2；缺省表示底座零样本。 */
  gptWeightsPath?: string
  sovitsWeightsPath?: string
}

/** 内置英雄音色包在面板上的样子：内置目录 + 本地安装状态合成一行。 */
export interface SovitsVoicePack {
  id: string
  name: string
  /** 训练轮次标识（如 e15 = GPT 第 15 轮），来自清单，换版即换号。 */
  version: string
  /** 一句话说明（面板小字），如「默认音色，引擎装完自动下载」。 */
  note: string
  defaultPack: boolean
  /** 三件套（参考音频 + GPT ckpt + SoVITS pth）总字节数。 */
  bytes: number
  /** 盘上已有且字节数对得上的部分（.part 不算），差 bytes-haveBytes 才是要下的。 */
  haveBytes: number
  installed: boolean
  /** 本地 refs.json 条目里记录的安装版本；旧安装没记录时为 null。 */
  installedVersion: string | null
  /** 清单版本与已装记录版本不同（换版了），面板据此把「下载」换「升级」。 */
  upgradable: boolean
  downloading: boolean
  /** 0–1；已就绪恒为 1。 */
  progress: number
  /** 当前 ttsSovitsRefAudio 指着这个包的参考音频（删除要拦）。 */
  active: boolean
  error: string | null
}

/**
 * IPC 通道契约（#30）：每条通道在契约表里只有一个家，通道名、参数、返回值、载荷都声明在同一行。
 * 渲染层的 window.api、preload 的桥、主进程的 handler 表全部从契约推导——
 * 加功能漏掉任何一步都是编译错，而不是运行时「点了没反应」的死选项。
 */
export interface InvokeChannel<A extends unknown[] = [], R = void> {
  /** 渲染层请求、主进程应答（ipcRenderer.invoke / ipcMain.handle）。 */
  kind: 'invoke'
  channel: string
  /** phantom：仅承载类型，运行时不存在。 */
  args?: A
  result?: R
}

export interface SendChannel<A extends unknown[] = []> {
  /** 渲染层单向发送、无应答（ipcRenderer.send / ipcMain.on）。 */
  kind: 'send'
  channel: string
  /** phantom：仅承载类型，运行时不存在。 */
  args?: A
}

export interface ListenChannel<P = void> {
  /** 主进程推送、渲染层订阅（webContents.send / ipcRenderer.on）。 */
  kind: 'listen'
  channel: string
  /** phantom：仅承载类型，运行时不存在。 */
  payload?: P
}

const invoke = <A extends unknown[], R>(channel: string): InvokeChannel<A, R> => ({ kind: 'invoke', channel })
const send = <A extends unknown[]>(channel: string): SendChannel<A> => ({ kind: 'send', channel })
const listen = <P>(channel: string): ListenChannel<P> => ({ kind: 'listen', channel })

/** 渲染层能调用的全部通道：invoke 请求应答、send 单向上抛、listen 主进程推送。 */
export const ipcContract = {
  // 设置 / 提供商 / 翻译
  getSettings: invoke<[], AppSettings>(IPC.SETTINGS_GET),
  setSettings: invoke<[Partial<AppSettings>], AppSettings>(IPC.SETTINGS_SET),
  testProvider: invoke<[ProviderConfig], TestResult>(IPC.PROVIDER_TEST),
  translate: invoke<[string, TranslateDirection?], string>(IPC.PROVIDER_TRANSLATE),
  translateReply: invoke<[string, ReplyTone?], ReplyResult>(IPC.REPLY_TRANSLATE),
  sendReply: invoke<[string], ReplySendResult>(IPC.REPLY_SEND),
  translateInPlace: invoke<[], InPlaceResult>(IPC.REPLY_INPLACE),
  translatorStatus: invoke<[], TranslatorStatus>(IPC.SESSION_STATUS),
  cacheStats: invoke<[], CacheStats>(IPC.CACHE_STATS),
  // 捕获账本与更新
  captureStart: invoke<[], CaptureStatus>(IPC.CAPTURE_START),
  captureStop: invoke<[], CaptureStatus>(IPC.CAPTURE_STOP),
  captureStatus: invoke<[], CaptureStatus>(IPC.CAPTURE_STATUS),
  onCaptureEntries: listen<CaptureEntry[]>(IPC.CAPTURE_ENTRIES),
  onCaptureUpdate: listen<CaptureEntry[]>(IPC.CAPTURE_UPDATE),
  onCaptureReplace: listen<CaptureEntry[]>(IPC.CAPTURE_REPLACE),
  appVersion: invoke<[], string>(IPC.APP_VERSION),
  updateCheck: invoke<[], UpdateState>(IPC.UPDATE_CHECK),
  updateInstall: invoke<[], boolean>(IPC.UPDATE_INSTALL),
  onUpdateStatus: listen<UpdateState>(IPC.UPDATE_STATUS),
  // 浮层：面板与热键共用
  overlayToggle: invoke<[], OverlayStatus>(IPC.OVERLAY_TOGGLE),
  overlayVoiceToggle: invoke<[], { ok: boolean }>(IPC.OVERLAY_VOICE_TOGGLE),
  overlaySetText: invoke<[OverlayTextMode], OverlayStatus>(IPC.OVERLAY_TEXT),
  overlayOpenReply: invoke<[], OverlayStatus>(IPC.OVERLAY_REPLY_OPEN),
  overlayCloseReply: invoke<[boolean?], OverlayStatus>(IPC.OVERLAY_REPLY_CLOSE),
  overlayReplyState: invoke<[], OverlayStatus>(IPC.OVERLAY_REPLY_STATE),
  onOverlayReply: listen<boolean>(IPC.OVERLAY_REPLY),
  onOverlayState: listen<OverlayStatus>(IPC.OVERLAY_STATE),
  onVoiceSpeak: listen<SpeakPayload>(IPC.VOICE_SPEAK),
  overlaySetGeometry: invoke<[Partial<OverlayGeometry>], OverlayStatus>(IPC.OVERLAY_GEOMETRY),
  overlayResetGeometry: invoke<[], OverlayStatus>(IPC.OVERLAY_GEOMETRY_RESET),
  overlaySetVoice: invoke<[boolean], OverlayStatus>(IPC.OVERLAY_VOICE),
  overlayToggleCollapse: invoke<[], OverlayStatus>(IPC.OVERLAY_COLLAPSE),
  overlayKeepAlive: invoke<[], void>(IPC.OVERLAY_KEEPALIVE),
  overlayNudge: invoke<[number, number], OverlayStatus>(IPC.OVERLAY_NUDGE),
  overlaySnap: invoke<[], OverlayStatus>(IPC.OVERLAY_SNAP),
  overlaySetLocked: invoke<[boolean], OverlayStatus>(IPC.OVERLAY_LOCK),
  overlaySetOpacity: invoke<[number], OverlayStatus>(IPC.OVERLAY_OPACITY),
  // 语音链：识别 / 翻译 / 声出
  voiceReply: invoke<[string], VoiceReplyResult>(IPC.VOICE_REPLY),
  reportVoiceState: send<[boolean]>(IPC.OVERLAY_VOICE_STATE),
  reportVoiceChain: send<[VoiceChainSummary]>(IPC.OVERLAY_VOICE_RESULT),
  onVoiceRecordToggle: listen<void>(IPC.VOICE_RECORD_TOGGLE),
  onVoiceRecordState: listen<{ recording: boolean }>(IPC.VOICE_RECORD_STATE),
  onVoiceChainResult: listen<VoiceChainSummary>(IPC.VOICE_CHAIN_RESULT),
  whisperProbe: invoke<[string], VoiceProbeResult>(IPC.VOICE_WHISPER_PROBE),
  whisperSetup: invoke<[], VoiceAssetsResult>(IPC.VOICE_WHISPER_SETUP),
  onWhisperProgress: listen<VoiceAssetProgress>(IPC.VOICE_WHISPER_PROGRESS),
  transcribeAudio: invoke<[string, string?], VoiceTranscribeResult>(IPC.VOICE_TRANSCRIBE),
  ttsPreview: invoke<[string], VoicePreviewResult>(IPC.VOICE_TTS_PREVIEW),
  voiceOutTest: invoke<[], VoiceOutTestResult>(IPC.VOICE_OUT_TEST),
  ttsOfflineState: invoke<[], OfflineStatus>(IPC.TTS_OFFLINE_STATE),
  ttsOfflineDownload: invoke<[], OfflineStatus>(IPC.TTS_OFFLINE_DOWNLOAD),
  asrStatus: invoke<[], OfflineStatus>(IPC.ASR_STATUS),
  asrDownload: invoke<[], OfflineStatus>(IPC.ASR_DOWNLOAD),
  // GPT-SoVITS
  sovitsStatus: invoke<[], SovitsStatus>(IPC.TTS_SOVITS_STATUS),
  sovitsInstall: invoke<[], SovitsStatus>(IPC.TTS_SOVITS_INSTALL),
  sovitsRefs: invoke<[], SovitsRefEntry[]>(IPC.TTS_SOVITS_REFS),
  sovitsVoicepacks: invoke<[], SovitsVoicePack[]>(IPC.TTS_SOVITS_VOICEPACKS),
  sovitsVoicepackInstall: invoke<[string], SovitsVoicePack[]>(IPC.TTS_SOVITS_VOICEPACK_INSTALL),
  sovitsVoicepackDelete: invoke<[string], SovitsVoicePack[]>(IPC.TTS_SOVITS_VOICEPACK_DELETE),
  sovitsSelectRef: invoke<[SovitsRefEntry], boolean>(IPC.TTS_SOVITS_SELECT_REF),
  sovitsSeed: invoke<[], boolean>(IPC.TTS_SOVITS_SEED),
  // 训练管理与 ASR 微调
  trainOpen: send<[]>(IPC.TRAIN_OPEN),
  trainStart: invoke<[TrainStartRequest], TrainStartResult>(IPC.TRAIN_START),
  trainStop: invoke<[], TrainStartResult>(IPC.TRAIN_STOP),
  trainSnapshot: invoke<[], TrainSnapshot>(IPC.TRAIN_SNAPSHOT),
  onTrainState: listen<TrainSnapshot>(IPC.TRAIN_STATE),
  ftScriptRead: invoke<[], FtScriptState>(IPC.FT_SCRIPT_READ),
  ftRecList: invoke<[], FtRecInfo[]>(IPC.FT_REC_LIST),
  ftRecSave: invoke<[string, string, Uint8Array], FtRecInfo>(IPC.FT_REC_SAVE),
  ftRecDelete: invoke<[string, string], void>(IPC.FT_REC_DELETE),
  ftRecRead: invoke<[string, string], Uint8Array>(IPC.FT_REC_READ),
  ftRecAsr: invoke<[string, string], VoiceTranscribeResult>(IPC.FT_REC_ASR),
  ftDatasetPrepare: invoke<[], FtDatasetPrepareResult>(IPC.FT_DATASET_PREPARE),
  ftAsrftStatus: invoke<[], AsrFtStatusResult>(IPC.FT_ASRFT_STATUS),
  ftAsrftInstall: invoke<[], AsrFtInstallState>(IPC.FT_ASRFT_INSTALL),
  ftAsrftApply: invoke<[], AsrFtSwapResult>(IPC.FT_ASRFT_APPLY),
  ftAsrftRollback: invoke<[], AsrFtSwapResult>(IPC.FT_ASRFT_ROLLBACK)
}

/** 声出隐藏窗口专用桥（面板用不到）：与主契约同构，各自绑定。 */
export const voiceOutContract = {
  onPlay: listen<VoiceOutPlayRequest>(IPC.VOICE_OUT_PLAY),
  onStart: listen<number>(IPC.VOICE_OUT_START),
  reportReady: send<[VoiceOutReadyReport]>(IPC.VOICE_OUT_READY),
  reportEnded: send<[VoiceOutEndedReport]>(IPC.VOICE_OUT_ENDED)
}

export type ChannelDef = InvokeChannel<unknown[], unknown> | SendChannel<unknown[]> | ListenChannel<unknown>

/** 契约表 → 方法签名表：invoke 变 Promise 调用，send 变单向发送，listen 变订阅。 */
export type ApiTable<T> = {
  [K in keyof T]: T[K] extends InvokeChannel<infer A, infer R>
    ? (...args: A) => Promise<R>
    : T[K] extends SendChannel<infer A>
      ? (...args: A) => void
      : T[K] extends ListenChannel<infer P>
        ? (callback: (payload: P) => void) => () => void
        : never
}

/** 主进程 handler 表：listen 通道是推送侧、不进表；invoke 可同步或异步应答。 */
export type MainHandlers = {
  [K in keyof typeof ipcContract as (typeof ipcContract)[K] extends ListenChannel<unknown> ? never : K]:
    (typeof ipcContract)[K] extends InvokeChannel<infer A, infer R>
      ? (...args: A) => R | Promise<R>
      : (typeof ipcContract)[K] extends SendChannel<infer A> ? (...args: A) => void : never
}

/** 声出隐藏窗口桥（window.api.voiceOut）。 */
export type VoiceOutApi = ApiTable<typeof voiceOutContract>

/** preload 暴露到 window.api 的完整契约（renderer 只认这个类型）。 */
export type WindowApi = ApiTable<typeof ipcContract> & { voiceOut: VoiceOutApi }

/** 死通道审计：通道常量没被任何契约表收编，就在这里炸成编译错。 */
type UsedChannel =
  | (typeof ipcContract)[keyof typeof ipcContract]['channel']
  | (typeof voiceOutContract)[keyof typeof voiceOutContract]['channel']
type DeadChannel = Exclude<typeof IPC[keyof typeof IPC], UsedChannel>
type AssertNoDeadChannel = [DeadChannel] extends [never] ? true : DeadChannel
export const deadChannelAudit: AssertNoDeadChannel = true
