/**
 * 设置形状域：AppSettings 的字段、默认值、默认短语表。
 * 从 ipc.ts 迁出（架构扫描 C2）：契约文件只留通道映射，设置长什么样归这里。
 * 依赖只进不来出得去：对 ipc.ts 只有类型边（编译期擦除），运行时仅依赖 hotkeys 的默认表。
 */
import type { QuickPhraseGroup } from './quick-phrases'
import { DEFAULT_CAPTURE_MODE, DEFAULT_HOTKEYS, type CaptureMode, type HotkeyActionId } from './hotkeys'
import type { ProviderConfig, ProviderId } from './providers'
import type { OfflineVoiceId, SpeakMode, VoiceOutEngine } from './voices'
import type { OverlayGeometry, OverlayTextMode, ReplyTone } from './ipc'
import type { DotaAnnounceTriggers } from './dota-announce'
import type { OverlayFontSize } from './overlay-a11y'

import type { BoundsMemory } from './display-geometry'
import type { SpeechSplitStrategy } from './speech-split'

export interface AppSettings {
  provider: ProviderConfig
  /**
   * 每个供应商各记各的 API Key（含 custom）：provider.apiKey 只是「当前生效」的那把，
   * 切预设时从这里按 id 取回，换家不用重新粘 key。写路径只有面板的 key 输入框。
   */
  providerKeys?: Partial<Record<ProviderId, string>>
  /**
   * 推理开关按供应商各记各的（含 custom）：provider.reasoning 只是「当前生效」的那格，
   * 切预设时从这里按 id 取回，换家不用重新点开关。预设表声明了 reasoning 的家以声明为准。
   */
  providerReasoning?: Partial<Record<ProviderId, boolean>>
  /**
   * zh-en 译文的词数上限（4-32，默认 16）：提示词上限行与回复截断共用一个值。
   * 改动会让翻译会话按新上限重建（进 runtimeConfigKey）。
   */
  translationMaxWords?: number
  proxyUrl: string
  targetLang: string
  /**
   * #120：中文行译成哪种语言（空 = 英文）。混编局里队友只说英文时没用，但俄语/东南亚局就是它。
   * 与 `targetLang` 一起由 `src/shared/target-language.ts` 归一，坏值回落默认。
   */
  targetLang2: string
  ttsOutputDevice: string
  /**
   * 同声传译（票 128）：我说中文，英文灌进游戏自己的话筒。
   * 关着时整条对讲链一个字都不变——这是默认值，也是「升级不影响现役玩法」的保证。
   */
  interpretMode: boolean
  /**
   * 同声灌哪台设备：'' = 跟 ttsOutputDevice（已经设成虚拟声卡的人不用再配一次）。
   * 选错的表现是队友听不到：设备 id 在人耳看来是一串盐值，所以面板按名字选（见 talk.tsx）。
   */
  interpretInDevice: string
  /** #97 停口窗口的预设：`short`（短促呼叫）/ `slow`（慢句子）。每次开麦现读，换档不需要重启。 */
  captureSilencePreset: string
  /**
   * 讲话设备（声音输入）：'' = 自动挑（跳过虚拟声卡与蓝牙通话端点，见 pickCaptureDevice）。
   * 选蓝牙耳机的麦克风会让 Windows 把耳机从音乐模式切到通话模式：游戏声音断一两秒、之后变单声道闷音。
   * 那是协议限制，软件绕不过；要一边听游戏一边说话，选内置的「麦克风阵列」。
   */
  micDevice: string
  /** 调试用：译文同时播到系统默认扬声器；正式使用时关掉，本机就只剩游戏里能听到。 */
  ttsMonitorLocal: boolean
  /**
   * 声出引擎：edge = 英文神经嗓占位（默认）；offline = 本地离线模型（中文嗓，念英文吞字）；
   * sovits = GV（GPT-SoVITS）音色包——音色由参考音频决定，权重切换走现有音色包管线。
   */
  ttsOutEngine: VoiceOutEngine
  /** 声出音色：edge 存声出清单里的英文嗓 id，offline 存离线清单里的本地嗓 id；GV 不用（空串）。 */
  ttsOutVoice: string
  /**
   * 影子模式（#80）：第一局只记账不出声——会照常翻译、也会记下「本该念的那句」，
   * 但不合成、不按说话键、不灌话筒。打完一局自动结束（按 `logs/gsi-summary/<matchid>.json`
   * 的份数判断），不靠人记得回来关。
   */
  shadowFirstMatch: boolean
  /** #93 逐人朗读开关：这些英雄短名不念（小写）。 */
  ttsMuteHeroes: string[]
  /** #93 逐人朗读开关：这些昵称 / 座位名不念（小写）。 */
  ttsMuteNames: string[]
  /** #85 切段策略：punctuation = 按标点（默认，自然但长句起播慢）/ uniform = 按固定字数（起播均匀，可能断词）。 */
  speechSplitStrategy: SpeechSplitStrategy
  /**
   * 说话键（push-to-talk）：游戏内按住才发言的按键，F1–F12 或单个字母/数字。
   * 声出期间由应用自动按下/松开（合成成功才按，头尾各留 200ms 余量）；乱填打回 F5。
   */
  ttsSpeakKey: string
  /**
   * 说话方式：hold = 播放期间按住说话键，播完再松开；toggle = 起播前敲一下开麦、播完再敲一下关麦。
   * 必须和游戏里语音按键的设置一致，否则队友听不到或频道一直开着。
   */
  ttsSpeakMode: SpeakMode
  /** 测试模式：开了只放音频到所选输出设备、不模拟按下说话键——游戏没开也能全链路试听，F5 不会落到别的窗口上。 */
  voiceOutTestMode: boolean
  /** 只看识别（测试用）：转写完就停——不翻译、不进剪贴板、不声出不按键。测口音/调模型用。 */
  voiceTranscribeOnly: boolean
  /**
   * 子句流水（#71）：识别文本按标点切成子句，第一句翻完就先出声，其余子句的翻译并行发出、
   * 仍按原顺序朗读。省下的是「等整段翻译」的往返，代价是丢掉跨句上下文，所以默认关。
   */
  clauseStreamVoice: boolean
  /**
   * 对讲耗时统计（默认关）：开了才给每句话记账——浮层那行多一行五段数字，面板记录行与
   * `logs/voice-chain.jsonl` 同步有；关着时一行都不量，界面上也没有数字可画。
   */
  voiceShowTiming: boolean
  /**
   * 现役识别模型 id（`<engine>:<rel>`），来自 ASR_MODELS 的注册表；空 = 按可用性自动选。
   * 引擎不再单独存（旧 `asrEngine` 字段已在 #67 退役）：模型属于哪个引擎由这个 id 的前缀决定。
   */
  asrActiveModel: string
  /**
   * 微调目标引擎 id（`qwen3` / `paraformer`）；空 = 跟着现役模型所属引擎走。
   * 与 `asrActiveModel` 分开：训练只要引擎在表里声明了 finetune 就能选，运行时模型还没装也行
   * （删掉旧权重、只留底模的场景）；训练成功转正时才把现役切过去。
   */
  asrTrainEngine: string
  /** 热词表（逗号/顿号分隔），仅 Qwen3 引擎注入；纠错回路自动追加，也可手编。 */
  asrHotwords: string
  /**
   * 纠错样本回喂（#66）：语音页把一句改对时，原始录音落成自由说样本（G01-Tnn），标签 = 改对的那句。
   * 关掉 = 纠错只并热词，不写任何文件。
   */
  asrCorrectionsToDataset: boolean
  /**
   * 短句/长句分流（#122）：短句走 paraformer（快、不带标点），长句走 qwen3（准）。
   * 默认关——两副模型都在场才有意义，而且开着就要把两份模型都留在内存里（#142 之后换引擎不重建，但第一句仍要各加载一次）。
   */
  asrRouteShortLong: boolean
  /** 训练窗口记住的任务类型：demo 演示任务；gv-gpt/gv-sovits/asr-ft 在 T3/T5 接入。 */
  trainKind: 'demo' | 'asr-ft' | 'gv-gpt' | 'gv-sovits'
  /** 训练窗口记住的数据集标识（T3 起是登记名，现在只是记下来下次自动填）。 */
  trainDataset: string
  /** ASR 微调环境根目录：空 = 用应用数据目录里的 asr-ft-env；手动搭的环境（试点那套）填根路径。 */
  asrFtEnvDir: string
  /** 总开关：关掉就只静默记录 GSI 帧，不当聊天处理、不翻译、不上屏。 */
  autoStartCapture: boolean
  /** 快捷短语表：呼出面板「短语」标签的内容，方向键选、Enter 复制进剪贴板。 */
  quickPhrases: string[]
  /**
   * #117：快捷短语的分组。`quickPhrases` 保持原样当「未分组」用——老用户的顺序不该被分组改动。
   * 空组不显示（`visibleGroups` 会丢掉），所以这里允许存半成品。
   */
  quickPhraseGroups: QuickPhraseGroup[]
  /** In-game nicknames that should never be translated (your own messages). */
  myNicknames: string[]
  replyTone: ReplyTone
  /** 浮层显示哪一层文字：默认只显示译文（译文未到时先用原文占位）。 */
  overlayText: OverlayTextMode
  /**
   * 浮层抬头先给一行战况摘要，逐行消息收在「展开」后面（#99）。
   * 摘要只搬已有行里的话，一次模型调用都不发；关掉就回到原来那种逐行列表。
   */
  overlayDigest: boolean
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
   * 对局播报总闸（#123）：智慧符、肉山窗口、堆野/拉野窗口用朗读同款嗓子念出来。
   * 默认关——关着时连状态机都不进，语音管线一次都不碰；开着再按 announceTriggers 逐条筛。
   */
  announceTotal: boolean
  /** 逐事件开关：没写的键按缺省（全开）。总闸关着时这里怎么设都不出声。 */
  announceTriggers?: Partial<DotaAnnounceTriggers>
  /**
   * 现役词表包（#82）：空串 = 用随包发布的内置对照表。非空时读数据目录
   * glossary/<名字>.json；文件坏了就回退内置并在面板留警告，不会静默换成空表。
   */
  glossaryPackName: string
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
  /** 上次退出时浮层是显示还是被「显示/隐藏浮层」热键藏了；启动时照此还原（「记忆隐藏」）。 */
  overlayVisible: boolean
  /** 每行底色不透明度（0.05–0.9）：游戏画面亮的时候要淡，暗图要深一点才看得清。 */
  overlayOpacity: number
  /**
   * 浮层字号三档（#100）：small / normal / large。每一档的四个像素值、以及「大档会不会撑破最小窗口」
   * 的判据都在 `src/shared/overlay-a11y.ts`，探针逐档验证；脏值一律回落 normal。
   */
  overlayFontSize: OverlayFontSize
  /** 用户调过的浮层几何；null = 跟随捕获区域自动摆放。 */
  /**
   * 每块屏幕各记一份浮层几何（#101）：屏幕 id → 几何。
   *
   * 之前只有一份，接着外接屏摆好、拔掉再插回来就白摆了。记的那块屏幕不在了由
   * `planBounds()` 决定整块落回主屏可见区；空表 = 还没在任何屏幕上摆过。
   */
  overlayBoundsByDisplay: BoundsMemory
  /**
   * 语音对讲热键怎么按：hold = 按住说话、松开触发；toggle = 按一下开录、再按一下触发。
   * 只影响「语音对讲」这一个动作；其余热键永远是敲一下。
   */
  voiceCaptureMode: CaptureMode
  /**
   * 副屏看板（#124a）：320 宽的长条，六项全部读 `matchSnapshot()`，开关它不动浮层任何状态。
   */
  boardVisible: boolean
  /**
   * 看板窗口上次摆的位置。**故意不复用 `overlayBoundsByDisplay`**：看板与浮层是两块不同的窗，
   * 共用一个键会让「动了看板」变成「动了浮层」。
   */
  boardBounds: OverlayGeometry | null
  /**
   * 全局热键表：动作 id → canonical 组合键，空串 = 该动作不绑键。
   * 单独一项而不是五个平铺字段——面板一次改整张表，平铺就要五个归一化分支加五处探针。
   */
  hotkeys: Record<HotkeyActionId, string>
/**
   * 用户在多 Steam 库之间选定的库根（绝对路径）；空 = 自动（库里找得到 Dota 用第一个）。
   * GSICFG 只在游戏启动时读一次，运行时挪库不会自动重算——选过就每次启动复核，
   * 找不到所选路径时报缺失、切回自动并给出提示（#78）。
   */
  gsiLibraryRoot: string
}

/** 快捷短语默认表：对局里高频、通用、不需要现场组织的英文短句；面板「文出」页可改。 */
export const DEFAULT_QUICK_PHRASES: string[] = [
  'Push mid',
  'Group up',
  'Fall back',
  'Careful, they are missing',
  'Nice play',
  'Well played',
  'My bad',
  'Give me a sec'
]

export const DEFAULT_SETTINGS: AppSettings = {
  /** #78：多 Steam 库时用户选定的库根，空 = 自动。 */
  gsiLibraryRoot: '',
  provider: {
    id: 'deepseek',
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat',
    reasoning: false
  },
  providerKeys: {},
  providerReasoning: {},
  translationMaxWords: 16,
  proxyUrl: '',
  targetLang: 'zh-CN',
  targetLang2: '',
  ttsOutputDevice: '',
  interpretMode: false,
  interpretInDevice: '',
  captureSilencePreset: 'short',
  micDevice: '',
  ttsMonitorLocal: false,
  ttsSpeakKey: 'F5',
  ttsSpeakMode: 'hold',
  voiceOutTestMode: false,
  voiceTranscribeOnly: false,
  clauseStreamVoice: false,
  voiceShowTiming: false,
  /** 现役模型空 = 由注册表按可用性自动选（#67 起引擎跟着这个 id 走，不再单独存）。 */
  asrActiveModel: '',
  /** 训练目标引擎空 = 跟现役模型走；填了就固定训这个引擎（运行时模型没装也能选）。 */
  asrTrainEngine: '',
  trainKind: 'demo',
  trainDataset: '',
  asrFtEnvDir: '',
  asrHotwords: '',
  /** 纠错样本默认开：它只是把用户已经改对的句子留成训练数据，不改变任何现有行为。 */
  asrCorrectionsToDataset: true,
  asrRouteShortLong: false,
  ttsOutEngine: 'edge',
  ttsOutVoice: '',
  shadowFirstMatch: true,
  speechSplitStrategy: 'punctuation',
  ttsMuteHeroes: [],
  ttsMuteNames: [],
  autoStartCapture: true,
  quickPhrases: DEFAULT_QUICK_PHRASES,
  quickPhraseGroups: [],
  myNicknames: [],
  replyTone: 'terse',
  overlayText: 'translated',
  overlayDigest: false,
  crossToneLookup: true,
  ttsReadAloud: false,
  ttsReadOwn: false,
  announceTotal: false,
  announceTriggers: { wisdom: true, rosh: true, stack: true, pull: true },
  glossaryPackName: '',
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
  overlayFontSize: 'normal',
  overlayBoundsByDisplay: {},
  voiceCaptureMode: DEFAULT_CAPTURE_MODE,
  boardVisible: false,
  boardBounds: null,
  hotkeys: { ...DEFAULT_HOTKEYS }
}
