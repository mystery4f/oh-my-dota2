import type { CableInstallResult, VirtualCableStatus, VoiceReplyStage } from './voice-out'
import type { VoiceChainTiming } from './voice-timing'
import type { VoiceStageEvent } from './voice-stage'
import type { CaptureMode, HotkeyActionId, HotkeyState, HotkeyVerdict } from './hotkeys'

import type { AsrFtFacts, AsrFtInstallState, AsrFtStatusResult, AsrFtSwapResult } from '@shared/train/asr-ft'
import type { VoiceRuntimeState } from '@shared/voice-runtime'
import type { VoiceOutReadiness } from '@shared/voice-out-readiness'
import type { FtDatasetPrepareResult } from '@shared/train/dataset'
import type { AsrCheckState } from '@shared/train/asr-check'
import type { GvDatasetJudgement, GvRegisterPayload, GvRegisterResult } from '@shared/train/gv'
import type { TrainLogPage, TrainSnapshot, TrainStartRequest, TrainStartResult } from '@shared/train/task'
import type { TrainRunRecord } from '@shared/train/run'
import type { AsrState } from '@shared/asr/models'
import type { FtScriptGroup, FtScriptState } from '@shared/train/recording'
import type { FtCorrectionInput, FtCorrectionSaveResult } from '@shared/train/corrections'
import type { ProviderConfig } from './providers'
import type { AppSettings } from './settings-shape'

// 读稿的类型归纯缝（解析与来源选择都在那里），契约只把它们带出来给渲染端。
export type { FtScriptGroup, FtScriptLine, FtScriptState } from '@shared/train/recording'

/** 一条录音：key 形如 G01-L03（free 组是 G21-T01），durationMs 由 16k mono wav 字节数推算。 */
export interface FtRecInfo {
  key: string
  bytes: number
  durationMs: number
  /** 文件修改时间（续训对账/已训标记的指纹之一）。 */
  mtimeMs: number
}
// 供应商域：类型与预设表的家在 ./providers（架构扫描 C2 迁出），契约只做再导出。
export type { ProviderId, ProviderConfig, ProviderPreset } from './providers'
export { PROVIDER_PRESETS, healProvider } from './providers'


// 音色域：离线音色清单的家在 ./voices（架构扫描 C2 迁出），契约只做再导出。
export type { OfflineVoiceId, OfflineVoice, VoiceOutEngine, SpeakMode } from './voices'
export { OFFLINE_VOICES, offlineVoicePreset } from './voices'
// 设置形状域：AppSettings 的家在 ./settings-shape（架构扫描 C2 迁出），契约只做再导出。
export type { AppSettings } from './settings-shape'

/**
 * 热键注册结果（动作 id → 抢到 / 被别的软件占了 / 这个动作没绑键）。
 * 只在主进程内存里，不落盘：它描述的是「这一次启动，系统有没有把键给到我们」。
 */
export type HotkeyVerdicts = Partial<Record<HotkeyActionId, HotkeyVerdict>>

/** 面板拿它一次画完整张热键表：动作 + 当前键 + 注册结果。 */
export interface HotkeysResult extends HotkeyState {
  /** 整张表被拒的原因（冲突/非法键）；null = 存好了。 */
  error: string | null
}

export { DEFAULT_QUICK_PHRASES } from './settings-shape'

export { DEFAULT_SETTINGS } from './settings-shape'

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
  /** 实际播到哪块输出设备；没起播（合成失败 / 窗口没就绪）时为空串。 */
  sinkLabel: string
  /** 说话键按下/松开失败的说明（播放照常进行，只是频道没开）。 */
  keyError?: string
  /** 整体失败原因（合成失败 / 窗口超时等）。 */
  error?: string
}

/** 打开外部链接的结果：只放行 https，失败原因直接给用户看。 */
export interface OpenExternalResult {
  ok: boolean
  error: string | null
}

/** 主进程 → 声出窗口：播这段音频，并按 requestedDevice 选输出。 */
export interface VoiceOutPlayRequest {
  requestId: number
  audioBase64: string
  audioMime: string
  requestedDevice: string
  /** 本机也放一份（调试用）：渲染层额外开一个默认输出播放器，与虚拟声卡那路同源同起。 */
  monitorLocal: boolean
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
  /** 起播准备的分段（ms）：枚举设备 / 绑定输出（含 base64→blob）/ 等解码起步。 */
  prep?: { devicesMs: number; sinkMs: number; metaMs: number }
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
  /** 分段计时：识别/翻译/首音/起播/播完各花了多久（voice-reply-latency）；量不到的段为 null。 */
  timing?: VoiceChainTiming
}

/** 对讲入参：`rowId` 由渲染端生成，阶段快照靠它才落得到那一条行上。 */
export interface VoiceReplyArgs {
  text: string
  rowId?: string
  /** 识别段耗时（毫秒）与麦克风：由 transcribeAudio 的结果原样带回，显式传递，不再有全局票据。 */
  asrMs?: number
  mic?: string
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
  /** 分段计时：浮层「已播」行与面板记录行读的就是它；识别都没跑就没这一项。 */
  timing?: VoiceChainTiming
  /**
   * 这一段原音的票据（主进程内存里那张 stash 的键）：面板纠错时原样送回去，
   * 主进程按它取录音。同一句说过两遍时文本一样、录音不同，只有票据分得清是哪一段。
   */
  utteranceId?: string
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

/** 清空缓存的数字口径：当前 provider 的记账对 + 会话槽；model 供确认框点名。 */
export interface TranslationCacheCounts {
  pairs: number
  conversations: number
  model: string
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
  /**
   * 失败时有没有把用户那句中文放回聊天框（只贴不回车）。
   * 原文在读取那一刻就从聊天框清空了，false = 那句中文没救回来，面板要提醒重打。
   */
  restored?: boolean
}

export interface PanelSuggestionsResult {
  ok: boolean
  items: string[]
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

/** Result of a speech transcription (Qwen3-ASR；#45 起 whisper.cpp 已退役，只剩这一种形状). */
export interface VoiceTranscribeResult {
  ok: boolean
  text: string
  error?: string
  /** 原音票据：纠错（`voice:correction`）凭它取回这段录音；没留录音时缺省。 */
  utteranceId?: string
  /** 识别耗时（毫秒）；渲染层把它随 voiceReply 显式带回主进程计时。 */
  asrMs?: number
  /** 录音设备 label|id 前 8 位；缺省为空。 */
  mic?: string
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


export interface OverlayStatus {
  visible: boolean
  /** 浮层显示什么：只译文（默认）／原文+译文／只原文。 */
  textMode: OverlayTextMode
  /** 呼出面板开着吗：开着 = 浮层临时可交互（历史/短语/AI 建议），关了恢复原状态。 */
  panelOpen: boolean
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
  /**
  /**
   * 当前配置的键名（给人看的写法），只带浮层自己要写的那几个动作。
   * 浮层没有设置访问权，键名不随状态下来就只能写死在渲染端里。
   */
  hotkeys: Partial<Record<HotkeyActionId, string>>
  /** 语音对讲怎么按：录音横幅要靠它选文案（按住 = 松开结束）。 */
  voiceCaptureMode: CaptureMode
  /** 快捷短语表（呼出面板第二页直接渲染）：随状态下来，浮层不读设置文件。 */
  quickPhrases: string[]
}

/** 浮层的位置与尺寸，全部是 DIP（和 `screen` 报的是同一套坐标）。 */
export interface OverlayGeometry {
  x: number
  y: number
  width: number
  height: number
}


export const IPC = {
  SETTINGS_GET: 'settings:get',
  SETTINGS_SET: 'settings:set',
  /** 读整张热键表 + 本次启动的注册结果。 */
  HOTKEYS_GET: 'hotkeys:get',
  /** 存整张热键表并立刻重注册；表里有冲突/非法键时整张拒收。 */
  HOTKEYS_SET: 'hotkeys:set',
  PROVIDER_TEST: 'provider:test',
  PROVIDER_TRANSLATE: 'provider:translate',
  CAPTURE_START: 'capture:start',
  CAPTURE_STOP: 'capture:stop',
  CAPTURE_STATUS: 'capture:status',
  /** 手动触发一次「拍屏 → OCR → 翻译 → 重建译文框」。 */
  /** 手动模式整屏重建（渲染层先清空再填充）。 */
  CAPTURE_REPLACE: 'capture:replace',
  /** 读取游戏聊天框草稿 → 翻译 → 原地替换成英文（不发送）。 */
  REPLY_INPLACE: 'reply:inplace',
  CAPTURE_ENTRIES: 'capture:entries',
  CACHE_STATS: 'cache:stats',
  /** 清空缓存两步走：inspect 只数数（确认框用），clear 才真删——都只对当前 provider。 */
  TRANSLATION_CACHE_INSPECT: 'cache:inspect',
  TRANSLATION_CACHE_CLEAR: 'cache:clear',
  UPDATE_CHECK: 'update:check',
  APP_VERSION: 'app:version',
  /** 只允许 https：面板里的安装引导用它打开官方下载页。 */
  APP_OPEN_EXTERNAL: 'app:open-external',
  UPDATE_INSTALL: 'update:install',
  UPDATE_STATUS: 'update:status',
  CAPTURE_UPDATE: 'capture:update',
  SESSION_STATUS: 'session:status',
  VOICE_TRANSCRIBE: 'voice:transcribe',
  /** 语音页纠错落库（#66）：把刚才那句的原始录音留成自由说样本，标签是改对的那句。 */
  VOICE_CORRECTION: 'voice:correction',
  // 语音链状态回显：overlay 起录/停录/出结果时报给主进程，主进程广播给面板。
  OVERLAY_VOICE_STATE: 'overlay:voice-record-state',
  OVERLAY_VOICE_RESULT: 'overlay:voice-chain-result',
  VOICE_RECORD_STATE: 'voice:record-state',
  VOICE_CHAIN_RESULT: 'voice:chain-result',
  VOICE_REPLY: 'voice:reply',
  VOICE_RECORD_TOGGLE: 'voice:record-toggle',
  /** 按住模式的两条推送：热键按下就开录，松开就停录并触发整条语音链。 */
  VOICE_RECORD_START: 'voice:record-start',
  VOICE_RECORD_STOP: 'voice:record-stop',
  VOICE_TTS_PREVIEW: 'voice:tts-preview',
  VOICE_OUT_TEST: 'voice-out:test',
  VOICE_OUT_PLAY: 'voice-out:play',
  VOICE_OUT_START: 'voice-out:start',
  VOICE_OUT_READY: 'voice-out:ready',
  VOICE_OUT_ENDED: 'voice-out:ended',
  OVERLAY_TOGGLE: 'overlay:toggle',
  OVERLAY_VOICE_TOGGLE: 'overlay:voice-record-toggle',
  OVERLAY_PANEL_TOGGLE: 'overlay:panel-toggle',
  OVERLAY_STATUS: 'overlay:status',
  /** 呼出面板数据：账本历史、AI 建议、点行复制。 */
  CHAT_HISTORY: 'chat:history',
  PANEL_SUGGESTIONS: 'panel:suggestions',
  COPY_TEXT: 'clipboard:copy',
  OVERLAY_TEXT: 'overlay:text',
  VOICE_SPEAK: 'voice:speak',
  VOICE_STAGE: 'voice:stage',
  TTS_OFFLINE_STATE: 'tts:offline-state',
  TTS_OFFLINE_DOWNLOAD: 'tts:offline-download',
  // 识别模型（Qwen3）状态与解压：和离线朗读同一套「状态 + 获取」面板节奏。
  ASR_STATUS: 'asr:status',
  ASR_DOWNLOAD: 'asr:download',
  // 模型注册表：列出磁盘上所有可用的识别模型、钉一份现役（换模型 = 换 id，不动代码）。
  ASR_MODELS: 'asr:models',
  ASR_ACTIVE_SET: 'asr:active-set',
  // 语音运行时（#45）：自带 node.exe + sherpa 插件的一键安装；模型下载复用 ASR_DOWNLOAD。
  VOICE_RUNTIME_STATUS: 'voice:runtime-status',
  VOICE_RUNTIME_INSTALL: 'voice:runtime-install',
  VOICE_MODEL_REMOVE: 'voice:model-remove',
  /** 主进程广播运行时状态（安装各阶段/结束时），面板据此翻状态牌。 */
  VOICE_RUNTIME_STATE: 'voice:runtime-state',
  // 训练管理（v3：并入面板；记录落盘，见 shared/train/run.ts）。
  TRAIN_START: 'train:start',
  TRAIN_STOP: 'train:stop',
  TRAIN_SNAPSHOT: 'train:snapshot',
  /** 主进程广播训练快照（任务状态 + 日志尾），训练窗口订阅。 */
  TRAIN_STATE: 'train:state',
  /** 训练记录（run）列表与单条详情：面板两页从磁盘读，重启后仍在。 */
  TRAIN_RUNS: 'train:runs',
  TRAIN_RUN: 'train:run',
  /** 训练日志文件（logs/train.log）的尾巴：训练过程到底跑到哪一步、崩在哪一行，面板只读这一份。 */
  TRAIN_LOG: 'train:log',
  // GV（GPT-SoVITS）微调（T3）：备料清单 / webui 开关 / 产物登记。
  TRAIN_GV_DATASETS: 'train:gv-datasets',
  TRAIN_GV_WEBUI: 'train:gv-webui',
  TRAIN_GV_REGISTER: 'train:gv-register',
  // ASR 微调录音（T4a）：内置读稿 + 录音存取，全部落在应用数据目录 asr-ft/ 下。
  FT_SCRIPT_READ: 'ft:script-read',
  // 读稿编辑器：保存写回数据目录那份（上一版备份成 asr-ft-script.bak.md），恢复则删掉它回到随包稿。
  FT_SCRIPT_SAVE: 'ft:script-save',
  FT_SCRIPT_RESET: 'ft:script-reset',
  FT_REC_LIST: 'ft:rec-list',
  FT_REC_SAVE: 'ft:rec-save',
  FT_REC_DELETE: 'ft:rec-delete',
  FT_REC_READ: 'ft:rec-read',
  FT_REC_ASR: 'ft:rec-asr',
  FT_DATASET_PREPARE: 'ft:dataset-prepare',
  // 全量识别比对：每条录音喂给现役模型，和稿子原文比一遍。结果只在内存里，关掉弹层就丢。
  ASR_CHECK_START: 'asr-check:start',
  ASR_CHECK_STOP: 'asr-check:stop',
  ASR_CHECK_STATE: 'asr-check:state',
  // ASR 微调闭环（T5）：环境状态 / 换模 / 回滚，训练+导出走 TRAIN_START/STOP。
  FT_ASRFT_STATUS: 'ft:asrft-status',
  FT_ASRFT_FACTS: 'ft:asrft-facts',
  FT_ASRFT_APPLY: 'ft:asrft-apply',
  FT_ASRFT_ROLLBACK: 'ft:asrft-rollback',
  FT_ASRFT_INSTALL: 'ft:asrft-install',
  TTS_SOVITS_STATUS: 'tts:sovits-status',
  TTS_SOVITS_INSTALL: 'tts:sovits-install',
  TTS_SOVITS_REFS: 'tts:sovits-refs',
  TTS_SOVITS_VOICEPACKS: 'tts:sovits-voicepacks',
  TTS_SOVITS_VOICEPACK_INSTALL: 'tts:sovits-voicepack-install',
  TTS_SOVITS_VOICEPACK_DELETE: 'tts:sovits-voicepack-delete',
  TTS_SOVITS_SELECT_PACK: 'tts:sovits-select-pack',
  TTS_SOVITS_SELECT_REF: 'tts:sovits-select-ref',
  TTS_SOVITS_SEED: 'tts:sovits-seed',
  /** #46：幂等的「把服务拉起来」，面板就绪行的一键动作走它。 */
  TTS_SOVITS_START_SERVER: 'tts:sovits-start-server',
  /** #46：声出就绪快照（读一次 + 变更推送），判断在 shared 的纯函数里。 */
  VOICE_OUT_READINESS: 'voice-out:readiness',
  VOICE_OUT_READINESS_STATE: 'voice-out:readiness-state',
  /** 虚拟声卡（VB-Cable）检测：声出能不能进游戏语音的前置。 */
  VOICE_OUT_CABLE: 'voice-out:cable',
  /** 一键安装 VB-Cable：下载官方包 → 解压 → 提权启动官方安装器（UAC/重启仍由用户完成）。 */
  VOICE_OUT_CABLE_INSTALL: 'voice-out:cable-install',
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

/** 所有主进程 → 渲染进程的频道名，广播函数用它拒掉拼错的频道。 */
export type IpcChannelValue = (typeof IPC)[keyof typeof IPC]

/** Contract exposed on window.api by the preload bridge. */
/** 离线朗读引擎（sherpa-onnx + Matcha）的安装状态。 */
export interface OfflineStatus {
  /** 本机是否有可用的 node.exe：sherpa 原生插件在 Electron 里跑不了（N-API 外部缓冲被禁）。 */
  available: boolean
  ready: boolean
  bytes: number
  dir: string
  downloading: boolean
  /** 真=字节已走完、正在逐件算 sha256（大文件上能停几秒，UI 要显示「校验中」而不是 100%）。 */
  verifying?: boolean
  /** 0–1；拿不到 Content-Length 时会停在 0。 */
  progress: number
  error: string | null
}

/** 通用语音侧操作回执（安装运行时 / 删除模型下载）。 */
export interface VoiceOperationResult {
  ok: boolean
  error: string | null
}

/** 语音运行时（自带 node.exe + sherpa 插件）状态，面板的「语音运行时」行。 */
export interface VoiceRuntimeStatus {
  state: VoiceRuntimeState
  /** 实际探测可用的 node.exe 路径（运行时内的优先，找不到为 null）。 */
  nodePath: string | null
  installing: boolean
  installError: string | null
}

/** 旧的一键下载入口（GitHub release tar 包），只留在文档里给离线用户。 */
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
  // 热键：读整张表、存整张表（存完主进程立刻重注册并重发浮层状态）。
  getHotkeys: invoke<[], HotkeysResult>(IPC.HOTKEYS_GET),
  setHotkeys: invoke<[Record<HotkeyActionId, string>], HotkeysResult>(IPC.HOTKEYS_SET),
  testProvider: invoke<[ProviderConfig], TestResult>(IPC.PROVIDER_TEST),
  translate: invoke<[string, TranslateDirection?], string>(IPC.PROVIDER_TRANSLATE),
  translateInPlace: invoke<[], InPlaceResult>(IPC.REPLY_INPLACE),
  translatorStatus: invoke<[], TranslatorStatus>(IPC.SESSION_STATUS),
  cacheStats: invoke<[], CacheStats>(IPC.CACHE_STATS),
  translationCacheInspect: invoke<[], TranslationCacheCounts>(IPC.TRANSLATION_CACHE_INSPECT),
  translationCacheClear: invoke<[], TranslationCacheCounts>(IPC.TRANSLATION_CACHE_CLEAR),
  // 捕获账本与更新
  captureStart: invoke<[], CaptureStatus>(IPC.CAPTURE_START),
  captureStop: invoke<[], CaptureStatus>(IPC.CAPTURE_STOP),
  captureStatus: invoke<[], CaptureStatus>(IPC.CAPTURE_STATUS),
  onCaptureEntries: listen<CaptureEntry[]>(IPC.CAPTURE_ENTRIES),
  onCaptureUpdate: listen<CaptureEntry[]>(IPC.CAPTURE_UPDATE),
  onCaptureReplace: listen<CaptureEntry[]>(IPC.CAPTURE_REPLACE),
  appVersion: invoke<[], string>(IPC.APP_VERSION),
  appOpenExternal: invoke<[string], OpenExternalResult>(IPC.APP_OPEN_EXTERNAL),
  updateCheck: invoke<[], UpdateState>(IPC.UPDATE_CHECK),
  updateInstall: invoke<[], boolean>(IPC.UPDATE_INSTALL),
  onUpdateStatus: listen<UpdateState>(IPC.UPDATE_STATUS),
  // 浮层：面板与热键共用
  overlayToggle: invoke<[], OverlayStatus>(IPC.OVERLAY_TOGGLE),
  overlayVoiceToggle: invoke<[], { ok: boolean }>(IPC.OVERLAY_VOICE_TOGGLE),
  overlaySetText: invoke<[OverlayTextMode], OverlayStatus>(IPC.OVERLAY_TEXT),
  overlayPanelToggle: invoke<[], OverlayStatus>(IPC.OVERLAY_PANEL_TOGGLE),
  overlayStatus: invoke<[], OverlayStatus>(IPC.OVERLAY_STATUS),
  chatHistory: invoke<[], CaptureEntry[]>(IPC.CHAT_HISTORY),
  panelSuggestions: invoke<[], PanelSuggestionsResult>(IPC.PANEL_SUGGESTIONS),
  copyText: invoke<[string], boolean>(IPC.COPY_TEXT),
  onOverlayState: listen<OverlayStatus>(IPC.OVERLAY_STATE),
  onVoiceSpeak: listen<SpeakPayload>(IPC.VOICE_SPEAK),
  // 对讲行的阶段留痕：主进程每完成一段发一份快照（voice-stage），渲染端只画不猜。
  onVoiceStage: listen<VoiceStageEvent>(IPC.VOICE_STAGE),
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
  voiceReply: invoke<[VoiceReplyArgs], VoiceReplyResult>(IPC.VOICE_REPLY),
  reportVoiceState: send<[boolean]>(IPC.OVERLAY_VOICE_STATE),
  reportVoiceChain: send<[VoiceChainSummary]>(IPC.OVERLAY_VOICE_RESULT),
  onVoiceRecordToggle: listen<void>(IPC.VOICE_RECORD_TOGGLE),
  onVoiceRecordStart: listen<void>(IPC.VOICE_RECORD_START),
  onVoiceRecordStop: listen<void>(IPC.VOICE_RECORD_STOP),
  onVoiceRecordState: listen<{ recording: boolean }>(IPC.VOICE_RECORD_STATE),
  onVoiceChainResult: listen<VoiceChainSummary>(IPC.VOICE_CHAIN_RESULT),
  onVoiceRuntimeState: listen<VoiceRuntimeStatus>(IPC.VOICE_RUNTIME_STATE),
  // 第二个参数是录音设备（`label|deviceId 前 8 位`），只进日志：deviceId 按 origin 加盐，
  // 和 settings 里存的那串对不上，人眼认名字。
  transcribeAudio: invoke<[string, string?], VoiceTranscribeResult>(IPC.VOICE_TRANSCRIBE),
  voiceCorrection: invoke<[FtCorrectionInput], FtCorrectionSaveResult>(IPC.VOICE_CORRECTION),
  ttsPreview: invoke<[string], VoicePreviewResult>(IPC.VOICE_TTS_PREVIEW),
  voiceOutTest: invoke<[], VoiceOutTestResult>(IPC.VOICE_OUT_TEST),
  ttsOfflineState: invoke<[], OfflineStatus>(IPC.TTS_OFFLINE_STATE),
  ttsOfflineDownload: invoke<[], OfflineStatus>(IPC.TTS_OFFLINE_DOWNLOAD),
  asrStatus: invoke<[], OfflineStatus>(IPC.ASR_STATUS),
  asrDownload: invoke<[], OfflineStatus>(IPC.ASR_DOWNLOAD),
  asrModels: invoke<[], AsrState>(IPC.ASR_MODELS),
  asrActiveSet: invoke<[string], AsrState>(IPC.ASR_ACTIVE_SET),
  voiceRuntimeStatus: invoke<[], VoiceRuntimeStatus>(IPC.VOICE_RUNTIME_STATUS),
  voiceRuntimeInstall: invoke<[], VoiceOperationResult>(IPC.VOICE_RUNTIME_INSTALL),
  voiceModelRemove: invoke<[], VoiceOperationResult>(IPC.VOICE_MODEL_REMOVE),
  // GPT-SoVITS
  sovitsStatus: invoke<[], SovitsStatus>(IPC.TTS_SOVITS_STATUS),
  sovitsInstall: invoke<[], SovitsStatus>(IPC.TTS_SOVITS_INSTALL),
  sovitsRefs: invoke<[], SovitsRefEntry[]>(IPC.TTS_SOVITS_REFS),
  sovitsVoicepacks: invoke<[], SovitsVoicePack[]>(IPC.TTS_SOVITS_VOICEPACKS),
  sovitsVoicepackInstall: invoke<[string], SovitsVoicePack[]>(IPC.TTS_SOVITS_VOICEPACK_INSTALL),
  sovitsVoicepackDelete: invoke<[string], SovitsVoicePack[]>(IPC.TTS_SOVITS_VOICEPACK_DELETE),
  sovitsSelectPack: invoke<[string], SovitsVoicePack[]>(IPC.TTS_SOVITS_SELECT_PACK),
  sovitsSelectRef: invoke<[SovitsRefEntry], boolean>(IPC.TTS_SOVITS_SELECT_REF),
  sovitsSeed: invoke<[], boolean>(IPC.TTS_SOVITS_SEED),
  // #46 声出就绪：一键把服务拉起 + 读/订阅就绪快照（判断只有一份，在 shared 里）。
  sovitsStartServer: invoke<[], SovitsStatus>(IPC.TTS_SOVITS_START_SERVER),
  voiceOutReadiness: invoke<[], VoiceOutReadiness | null>(IPC.VOICE_OUT_READINESS),
  voiceOutCable: invoke<[], VirtualCableStatus>(IPC.VOICE_OUT_CABLE),
  voiceOutCableInstall: invoke<[], CableInstallResult>(IPC.VOICE_OUT_CABLE_INSTALL),
  onVoiceOutReadiness: listen<VoiceOutReadiness | null>(IPC.VOICE_OUT_READINESS_STATE),
  // 训练管理与 ASR 微调
  trainStart: invoke<[TrainStartRequest], TrainStartResult>(IPC.TRAIN_START),
  trainStop: invoke<[], TrainStartResult>(IPC.TRAIN_STOP),
  trainSnapshot: invoke<[], TrainSnapshot>(IPC.TRAIN_SNAPSHOT),
  trainRuns: invoke<[], TrainRunRecord[]>(IPC.TRAIN_RUNS),
  trainRun: invoke<[string], TrainRunRecord | null>(IPC.TRAIN_RUN),
  trainLog: invoke<[{ limit?: number }], TrainLogPage>(IPC.TRAIN_LOG),
  onTrainState: listen<TrainSnapshot>(IPC.TRAIN_STATE),
  trainGvDatasets: invoke<[], GvDatasetJudgement[]>(IPC.TRAIN_GV_DATASETS),
  trainGvWebui: invoke<[{ open: boolean }], { ok: boolean; running: boolean; error?: string }>(IPC.TRAIN_GV_WEBUI),
  trainGvRegister: invoke<[GvRegisterPayload], GvRegisterResult>(IPC.TRAIN_GV_REGISTER),
  ftScriptRead: invoke<[], FtScriptState>(IPC.FT_SCRIPT_READ),
  ftScriptSave: invoke<[FtScriptGroup[]], FtScriptState>(IPC.FT_SCRIPT_SAVE),
  ftScriptReset: invoke<[], FtScriptState>(IPC.FT_SCRIPT_RESET),
  ftRecList: invoke<[], FtRecInfo[]>(IPC.FT_REC_LIST),
  ftRecSave: invoke<[string, string, Uint8Array], FtRecInfo>(IPC.FT_REC_SAVE),
  ftRecDelete: invoke<[string, string], void>(IPC.FT_REC_DELETE),
  ftRecRead: invoke<[string, string], Uint8Array>(IPC.FT_REC_READ),
  ftRecAsr: invoke<[string, string], VoiceTranscribeResult>(IPC.FT_REC_ASR),
  ftDatasetPrepare: invoke<[], FtDatasetPrepareResult>(IPC.FT_DATASET_PREPARE),
  asrCheckStart: invoke<[], AsrCheckState>(IPC.ASR_CHECK_START),
  asrCheckStop: invoke<[], AsrCheckState>(IPC.ASR_CHECK_STOP),
  asrCheckState: invoke<[], AsrCheckState>(IPC.ASR_CHECK_STATE),
  ftAsrftStatus: invoke<[], AsrFtStatusResult>(IPC.FT_ASRFT_STATUS),
  ftAsrftFacts: invoke<[], AsrFtFacts>(IPC.FT_ASRFT_FACTS),
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
