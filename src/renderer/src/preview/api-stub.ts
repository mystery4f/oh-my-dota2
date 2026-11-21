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
 * can be inspected without clicking through the panel; `?asrModel=paraformer` puts 识别训练 on the
 * FunASR fine-tune leg (target row and estimate both follow it); `?script=bad` makes the read script
 * fail so the fallback warning row on 识别训练 is visible.
 */
import { DEFAULT_SETTINGS, type FtRecInfo, type OverlayTextMode, type VoiceChainSummary, type WindowApi } from '@shared/ipc'
import { snapshotOf } from '@shared/match-snapshot'
import { renderGroups } from '@shared/quick-phrases'
import { summarizeProviderCalls } from '@shared/provider-metrics'
import { failureLine, judgeProviderFailure } from '@shared/provider-failure'
import { catalogOf } from '@shared/probe-catalog'
import { DEFAULT_HOTKEYS, describeHotkeys } from '@shared/hotkeys'
import type { OverlayFontSize } from '@shared/overlay-a11y'
import { ASR_ENGINE_LIST, type AsrEngineSpec } from '@shared/asr/engines'
import { estimateFtCost, summarizePendingTakes } from '@shared/train/asr-ft'
import { gradeAsrCheck, type AsrCheckItem, type AsrCheckState } from '@shared/train/asr-check'
import type { CerCohort } from '@shared/train/cer'
import { judgeCorrectionSamples } from '@shared/train/corrections'
import { mergePlan, rankCandidates, type HotwordCandidate, type HotwordSuggestions } from '@shared/asr-hotword-candidates'
import { judgeFirstRun } from '@shared/first-run'
import { summarizeErrors } from '@shared/error-log'
import { summarizeMarks } from '@shared/translation-mark'
import { judgeGsiStall, gsiStallWarning } from '@shared/gsi-stall'
import { judgeEnv } from '@shared/env-report'
import { shadowView } from '@shared/shadow-voice'
import { resolveGsiRoot } from '@shared/gsi-lib'

const settings: typeof DEFAULT_SETTINGS = structuredClone(DEFAULT_SETTINGS)
const query = new URLSearchParams(location.search)
const engine = query.get('engine') as typeof settings.ttsEngine | null
const outEngine = query.get('outEngine') as typeof settings.ttsOutEngine | null
const scriptMode = query.get('script')
if (engine) settings.ttsEngine = engine
if (outEngine) settings.ttsOutEngine = outEngine
// ?interpret=1：同声模式开着，且这台设备就是虚拟电缆——面板上「同声翻译」那一行才有句子可读。
if (query.get('interpret') === '1') {
  settings.interpretMode = true
  settings.interpretInDevice = ''
  settings.ttsOutputDevice = 'cable-0'
}
/**
 * `?voiceDemo` 时预览页自己收一次「对讲完成」：面板「识别记录」行与浮层的完成行都要有真实结果才看得见。
 * 数字就是 `formatChainTiming` 会画的那五段，缺一段不写 0。
 */
const stubVoiceChain: VoiceChainSummary = {
  transcript: 'stub 这句中文会被识别出来',
  translated: 'The stub line comes back translated.',
  spoken: true,
  stage: null,
  error: null,
  utteranceId: 'stub-utterance',
  // ?interpret=1：这一条走的是同声腿——阶段名单列，还带着灌进去的那台设备（票 128）。
  ...(query.get('interpret') === '1' ? { stage: 'interpret', sink: 'CABLE Input (VB-Audio Virtual Cable)' } : {}),
  timing: {
    asrMs: 690,
    translateMs: 1180,
    firstAudioMs: 2100,
    playStartMs: 2100,
    speakMs: 3600,
    totalMs: 3970
  }
}

/** 演示只发一次，挂了几个监听都只算一次。 */
let chainDemoSent = false

const hotkeys = { ...DEFAULT_HOTKEYS }
const hotkeyPayload = (): Awaited<ReturnType<WindowApi['getHotkeys']>> => ({
  actions: describeHotkeys(hotkeys).actions,
  error: null
})

/** `?offline=failed|missing` 把离线模型换成「缺文件 / 上一轮失败」，看那两态长什么样。 */
const offlineState = (): Awaited<ReturnType<WindowApi['ttsOfflineState']>> => {
  const mode = query.get('offline')
  if (mode === 'failed')
    return {
      available: false,
      ready: false,
      bytes: 41_943_040,
      dir: 'data/tts-offline',
      downloading: false,
      progress: 0,
      error: 'HTTP 404'
    }
  if (mode === 'missing')
    return { available: false, ready: false, bytes: 0, dir: 'data/tts-offline', downloading: false, progress: 0, error: null }
  return {
    available: true,
    ready: true,
    bytes: 136314880,
    dir: 'data/tts-offline',
    downloading: false,
    progress: 1,
    error: null
  }
}

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
/** 浮层预览的假聊天行：一条「不见了」、一条「需要」、两条清汤寡水——摘要与逐行都能看出区别。 */
function stubOverlayEntries(): import('@shared/ipc').CaptureEntry[] {
  const now = Date.now()
  const raw: Array<[string, string, string | null]> = [
    ['[队友] [队友A] gg', 'gg', 'gg'],
    ['[队友] [队友B] mid is missing', 'mid is missing', '中路不见了'],
    ['[队友] [队友A] need 4 top', 'need 4 top', '上路要人来'],
    ['[队友] [队友C] nice', 'nice', '漂亮']
  ]
  return raw.map(([original, body, translated], index) => ({
    id: `stub-${index}`,
    ts: now - (raw.length - index) * 1200,
    original,
    body,
    translated
  }))
}

const overlay = {
  visible: true,
  textMode: 'translated' as OverlayTextMode,
  // 真机默认关（settings.overlayDigest=false）：预览照同一口径，?digest=1 才开。
  digest: query.get('digest') === '1',
  // ?panel=1 直接以呼出面板的样子开预览（#103 焦点验收用）。
  panelOpen: query.has('panel'),
  quickPhrases: ['Push mid', 'Fall back', 'Nice play'],
  // ?unlocked=1 才能点工具条与「展开」——锁定时浮层整块点击穿透，预览也照这个规则来。
  locked: query.get('unlocked') !== '1',
  collapsed: false,
  readAloud: false,
  opacity: 0.45,
  // ?font=small|large 让预览也能看三档字号；?s=overlay 的按钮同样走这条桩。
  fontSize: (query.get('font') ?? 'normal') as OverlayFontSize,
  geometry: { x: 220, y: 180, width: 520, height: 260 },
  hint: null,
  hotkeys: {
    overlayToggle: 'Alt+Shift+O',
    overlayLock: 'Alt+Shift+P',
    overlayCollapse: 'Alt+Shift+B',
    overlayPanel: 'Alt+Shift+H'
  },
  voiceCaptureMode: 'hold' as const
}
function stubMatchTimeline(): { matchid: string; entries: never[]; line: string } {
  return { matchid: '7600111222', entries: [], line: '这局还没有值得停一下的事' }
}

const overlaySnap = (): Awaited<ReturnType<WindowApi['overlayStatus']>> => ({
  ...overlay,
  geometry: { ...overlay.geometry }
})

/** `?packs=all` 把每个包都当成装好的：用来看「要下的东西」收成一行那半边的样子。 */
const packsAllInstalled = query.get('packs') === 'all'
/** #175：抬头三态的开关键——`?ov=stalled|notready|ok`，一屏一态，截图在同一次会话里拍。 */
const overviewMode = query.get('ov')

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
/**
 * 一条假比对：分档与 CER 都走真函数，只把「识别结果」编出来。
 * 假数据自己算 distance 的话，面板上的 CER 一改口径就和真机对不上了。
 */
function stubCheck(key: string, expected: string, actual: string, cohort: CerCohort): AsrCheckItem {
  return { ...gradeAsrCheck(key, expected, actual), cohort }
}

const stubNow = Date.now()
// 全量识别比对的假结果：三条一致、一条差 1 字、一条明显错，够看清弹层的样子。
let stubAsrCheck: AsrCheckState = {
  running: false,
  done: 5,
  total: 5,
  current: '',
  startedAt: 0,
  finishedAt: 0,
  error: null,
  canceled: false,
  items: [
    stubCheck('G14-L01', '我的跳刀还没好', '我的跳刀还没好。', 'train'),
    stubCheck('G14-L02', '我没到还在冷却', '我没到还在冷却。', 'train'),
    stubCheck('G15-L04', '我的真视有了，能排眼', '我的镇也有了，人排也。', 'train'),
    stubCheck('G20-L12', '对面在偷盾，快回来', '对面在偷蹲快回来。', 'eval'),
    stubCheck('G99-T01', '我方高地塔要掉了先撤', '我们高地要掉了。', 'eval')
  ]
}

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
    id: 'asr-ft-stub-trained',
    kind: 'asr-ft',
    experiment: '地图-20261107190000',
    params: { epochs: 3, lr: '1e-4', resumeFrom: null },
    data: { files: 36, durationMs: 108_000, bytes: 388_000 },
    status: 'trained',
    startedAt: stubNow - 9 * 60 * 60 * 1000,
    endedAt: stubNow - 7 * 60 * 60 * 1000,
    artifacts: { runDir: 'data/asr-ft-runs/地图-20261107190000', ckptDir: 'data/asr-ft-runs/地图-20261107190000' },
    metrics: { steps: 1200, epochs: 3, bestLoss: 0.42, lastLoss: 0.45, series: [] },
    applied: false,
    error: null,
    auditionSkip: { at: stubNow - 7 * 60 * 60 * 1000, auto: false, reason: '这一轮只用来对齐底模，跳过试听' }
  },
  {
    id: 'asr-ft-stub-early',
    kind: 'asr-ft',
    experiment: '地图-20261106190000',
    params: { epochs: 66, lr: '2e-5', resumeFrom: null },
    data: { files: 33, durationMs: 99_000, bytes: 355_000 },
    status: 'trained',
    startedAt: stubNow - 26 * 60 * 60 * 1000,
    endedAt: stubNow - 24 * 60 * 60 * 1000,
    artifacts: { runDir: 'data/asr-ft-runs/地图-20261106190000', ckptDir: 'data/asr-ft-runs/地图-20261106190000' },
    metrics: { steps: 2100, epochs: 21, bestLoss: 0.38, lastLoss: 0.4, series: [] },
    applied: false,
    error: null,
    auditionSkip: { at: stubNow - 24 * 60 * 60 * 1000, auto: true, reason: '验证集 5 轮没降，早停' }
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
      series: Array.from({ length: 8 }, function (_, i) { return { step: i + 1, epoch: i + 1 } })
    },
    applied: true,
    error: null
  }
]
// `?audition=1`：换模前停在「待试听」的那一轮（#105），现役这一步才会摆出两副模型的并排结果。
if (query.get('audition') === '1') {
  stubTrainRuns.push({
    id: 'asr-ft-stub-audition',
    kind: 'asr-ft',
    experiment: '地图-20261109080000',
    params: { epochs: 66, lr: '2e-5', resumeFrom: null },
    data: { files: 41, durationMs: 132_000, bytes: 442_000 },
    status: 'trained',
    startedAt: stubNow - 40 * 60 * 1000,
    endedAt: stubNow - 6 * 60 * 1000,
    artifacts: { runDir: 'data/asr-ft-runs/地图-20261109080000', ckptDir: 'data/asr-ft-runs/地图-20261109080000' },
    metrics: null,
    applied: false,
    error: null,
    audition: {
      rows: [
        { key: 'G14-L01', expected: '我的跳刀还没好', before: '我的跳还没好', after: '我的跳刀还没好', beforeCer: 0.14, afterCer: 0, better: 'after' },
        { key: 'G14-L07', expected: '对面在偷盾，快回来', before: '对面在偷盾快回来', after: '对面在偷盾快回来', beforeCer: 0.1, afterCer: 0.1, better: 'same' },
        { key: 'G20-L12', expected: '中路不见了', before: '中路不见', after: '中路不见了', beforeCer: 0.2, afterCer: 0, better: 'after' }
      ],
      count: 3,
      better: 2,
      worse: 0,
      same: 1,
      beforeCer: 0.18,
      afterCer: 0.06,
      verdict: 'better',
      at: stubNow - 5 * 60 * 1000
    },
    auditionSkip: null
  })
}

/**
 * 识别训练页的状态开关（#173）：`?asr=env|nodata|no-base|ready|running|failed|live`。
 * 这页的抬头四态本来就只能靠真实训练状态触发（缺环境要真的缺、训练中要真的在跑），
 * 预览里不给开关就永远看不到，设计侧也就无从检查。桩只喂事实，判据仍在页面自己的纯缝里。
 */
type AsrStubState = 'env' | 'nodata' | 'no-base' | 'ready' | 'running' | 'failed' | 'live'
const asrStub: AsrStubState = (query.get('asr') as AsrStubState | null) ?? 'ready'

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
// `?train=idle` 时训练不占着：比对按钮平时被「正在训练」挡着，没有这个开关就看不到弹层。
if (query.get('train') === 'idle') {
  stubTrainSnapshot.task = {
    id: 'train-stub',
    kind: 'asr-ft',
    dataset: '地图-20261108010000',
    status: 'idle',
    progress: 0,
    stage: '',
    startedAt: stubNow - 12 * 60 * 1000,
    endedAt: stubNow,
    inference: 'released'
  }
  stubTrainSnapshot.logs = []
}

/**
 * 训练页的假数据：读稿只放 4 组（逐句 3 组 + 自由说 1 组），录音给 G14 三条，够看清
 * 句号条三态、覆盖率与体检提示，又不至于把预览页撑成一屏滚不到底。
 */
const stubScript = {
  groups: [
    { id: 'G14', title: '对线', mode: 'lines' as const, note: '', lines: Array.from({ length: 20 }, (_, index) => ({ no: index + 1, text: `这是 G14 的第 ${index + 1} 句稿子，长度按真实稿子来，用来检查换行与按钮排布` })) },
    { id: 'G15', title: '团战', mode: 'lines' as const, note: '', lines: [1, 2, 3, 4].map((no) => ({ no, text: `这是 G15 的第 ${no} 句稿子` })) },
    { id: 'G19', title: '报点', mode: 'lines' as const, note: '', lines: [1, 2, 3].map((no) => ({ no, text: `这是 G19 的第 ${no} 句稿子` })) },
    { id: 'G21', title: '自由说', mode: 'free' as const, note: '想到什么说什么', lines: [] }
  ],
  source: scriptMode === 'bad' ? ('bundled' as const) : ('data' as const),
  path: scriptMode === 'bad' ? 'resources/asr-ft-script.md' : 'data/asr-ft-script.md',
  warning: scriptMode === 'bad' ? '数据目录的读稿（data/asr-ft-script.md）格式不对（要 `## G14` 组标题 + 编号句），已回落到自带读稿' : null,
  error: null
}
const stubTake = (key: string, bytes: number, durationMs: number, mtimeMs: number): FtRecInfo => ({ key, bytes, durationMs, mtimeMs })
/** 预览里的录音集：G14 开头三句已录（可看标记与自动前进），G19 整组录完（可看完成态）。 */
const stubRecs: FtRecInfo[] = [
  ...[1, 2, 3].map((no) => stubTake(`G14-L${String(no).padStart(2, '0')}`, 62_000 + no * 4000, 1900 + no * 120, stubNow - no * 86_400_000)),
  ...[1, 2, 3].map((no) => stubTake(`G19-L${String(no).padStart(2, '0')}`, 58_000 + no * 3000, 1600 + no * 90, stubNow - no * 43_200_000))
]
/** 预览里的纠错样本（#66）：只记字节数，够 judgeCorrectionSamples 算出条数/字节/到顶。 */
const stubCorrections: { bytes: number }[] = [{ bytes: 96_000 }, { bytes: 88_000 }]
const stubGvDatasets = [
  { expName: 'mirana', ready: true, missing: [] },
  { expName: 'windranger', ready: false, missing: ['语义表 6-name2semantic.tsv'] }
]
let stubWebuiRunning = false

/** 预览里的 ASR 模型表：两条微调腿各一个，`?asrModel=paraformer` 让识别训练直接落在 FunASR 腿上。 */
const stubAsrModels = [
  { id: 'qwen3:asr-models/qwen3-asr', engineId: 'qwen3', label: 'Qwen3-ASR 0.6B', rel: 'asr-models/qwen3-asr', ready: true, bytes: 986491745, origin: 'download' },
  { id: 'qwen3:asr-models/qwen3-asr.bak', engineId: 'qwen3', label: 'Qwen3-ASR 0.6B（备份）', rel: 'asr-models/qwen3-asr.bak', ready: true, bytes: 986491745, origin: 'backup' },
  { id: 'paraformer:asr-models/paraformer-zh', engineId: 'paraformer', label: 'Paraformer 中文', rel: 'asr-models/paraformer-zh', ready: true, bytes: 895000000, origin: 'download' }
] as const
let stubAsrActiveId = query.get('asrModel') === 'paraformer' ? 'paraformer:asr-models/paraformer-zh' : 'qwen3:asr-models/qwen3-asr'
// 设置里的现役 id 是页面判断「训练目标和现役不是同一个引擎」的唯一来源，stub 也要跟着走这条。
settings.asrActiveModel = stubAsrActiveId

// #74 候选池的桩：预览里没有真人纠错，池子是一份造出来的典型样本；写词表走真 `mergePlan`，
// 所以「表满丢哪几个」「已在表里几个」这些数字在预览里也跟真机一致。
// `?hotwords=full` 把词表填到只剩一个空位：不这样，#138 那种「表满丢下」的路径
// 只能靠人手敲 49 个词才能走到，等于没人检查。
if (query.get('hotwords') === 'full') {
  settings.asrHotwords = Array.from({ length: 49 }, (_, i) => `词${i}`).join(',')
}
let stubHotwordPool: HotwordCandidate[] = [
  { word: '肉山', count: 4, samples: ['我们打肉山啊', '肉山在上路'] },
  { word: '马尔斯', count: 2, samples: ['我们打个哈斯卡', '对面马而斯'] },
  { word: '跳刀', count: 1, samples: ['先出跳刀吗'] }
]
const stubHotwordCorrections = 7

/** #82 词表包桩：名字为空或「内置」= 内置表；名字是「坏包」= 装不上、带警告。 */
function glossaryStub(name?: string): import('@shared/glossary-pack').GlossaryPackStatus {
  const wanted = name ?? (query.get('pack') ?? '')
  const available = ['演示词表', '坏包']
  if (wanted === '' || wanted === '内置') {
    const fallback = wanted === '内置' && query.get('pack') === '坏包'
    return {
      name: '内置',
      source: 'bundled',
      entries: 78,
      error: fallback ? 'glossary/坏包.json: 第 2 条的 kind 只能是 hero / item / jargon' : null,
      file: null,
      available
    }
  }
  if (wanted === '坏包') {
    return {
      name: '内置',
      source: 'bundled',
      entries: 78,
      error: 'glossary/坏包.json: 第 2 条的 kind 只能是 hero / item / jargon',
      file: '坏包.json',
      available
    }
  }
  return { name: '演示词表', source: 'pack', entries: 5, error: null, file: '演示词表.json', available }
}

function stubHotwordView(): HotwordSuggestions {
  return {
    corrections: stubHotwordCorrections,
    hotwords: settings.asrHotwords,
    suggestions: rankCandidates(stubHotwordPool, settings.asrHotwords)
  }
}
/**
 * 现役模型的微调腿：与主进程 finetuneEngine 同一判据（activeId 的引擎 → 引擎表 finetune），
 * 目标行与估时都读它——换一条腿，预览里的 trainer / 步数 / 分钟跟着换。
 */
function stubFinetuneEngine(): AsrEngineSpec {
  // 与主进程 finetuneEngine 同一条规则：显式训练目标优先，其次现役引擎，最后表里第一个可微调的。
  const pinned = settings.asrTrainEngine
  if (pinned) {
    const spec = ASR_ENGINE_LIST.find((item) => item.id === pinned && item.finetune !== null)
    if (spec) return spec
  }
  const picked = ASR_ENGINE_LIST.find((spec) => stubAsrActiveId.startsWith(`${spec.id}:`))
  if (picked?.finetune != null) return picked
  const fallback = ASR_ENGINE_LIST.find((spec) => spec.finetune !== null)
  if (fallback === undefined) throw new Error('引擎表里没有任何引擎声明 finetune')
  return fallback
}

/** 能进训练的逐句录音（自由说组没有标准答案）：账本 / 估时只数这些。 */
function stubLineRecs(): FtRecInfo[] {
  const lineKeys = new Set(
    stubScript.groups.flatMap((group) =>
      group.mode === 'lines' ? group.lines.map((line) => `${group.id}-L${String(line.no).padStart(2, '0')}`) : []
    )
  )
  return stubRecs.filter((rec) => lineKeys.has(rec.key))
}

/** 面板真正调用的通道，逐个给出类型正确的假答复。 */
const implemented = {
  // 必须回副本：真机每次 IPC 都过一遍结构化克隆，预览里回同一个对象的话
  // React 的 `setState` 会因引用没变而跳过重渲染，面板就停在旧值上（热词并入后输入框还是 0/50）。
  getSettings: async () => ({ ...settings }),
  setSettings: async (patch) => {
    Object.assign(settings, patch)
    return { ...settings }
  },
  testProvider: async () => {
    // ?probe=bad：连通性失败态要截图，而失败那句话必须是真的 `failureLine()` 输出——
    // 桩自己编一句「失败了」就会让截图证明不了「页面用的是同一句话」。
    if (query.get('probe') === 'bad')
      return { ok: false, message: failureLine(judgeProviderFailure({ status: 401, message: 'HTTP 401 Invalid API key' })) }
    return { ok: true, message: 'stub ok', latencyMs: 321 }
  },
  translationCacheInspect: async () => cacheCounts(),
  translationCacheClear: async () => cacheCounts(),
  translate: async () => '（stub 译文）careful mid',
  getHotkeys: async () => hotkeyPayload(),
  setHotkeys: async (map) => {
    Object.assign(hotkeys, map)
    return hotkeyPayload()
  },
  // 驾驶室（#165）的空态截图要用：?noSnapshot=1 就是「还没收到过 GSI 帧」——
  // 真机上这条通道在没帧时是 reject，页面 .catch(() => null) 才走到空态那一句。
  matchSnapshot: async () => {
    if (query.has('noSnapshot')) throw new Error('预览桩：还没收到过 GSI 帧')
    return snapshotOf({
      map: { matchid: '7600111222', game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', clock_time: 183, daytime: true },
      hero: { name: 'npc_dota_hero_nevermore', level: 7, alive: true, gold: 1200, kills: 3, deaths: 1, assists: 5 },
      abilities: { ability_0: { name: 'nevermore_shadowraze1', level: 4 }, ability_1: { name: 'nevermore_presence', level: 2 } },
      items: { slot0: { name: 'item_blink', id: 1 }, slot1: { name: 'item_tango', id: 2 } }
    })
  },
  /**
   * #161 驾驶室：真对局拿不到别人名字，所以默认这一屏**没有**英雄名（也就没有静音开关）。
   * `?ch=hero` 造观战/训练场那种「拿到了英雄名」的情形，看静音那一段长什么样。
   */
  speakerChannels: async () => {
    const now = Date.now()
    const mode = query.get('ch')
    if (mode === 'empty') return { matchid: null, channels: [], line: '这局还没人说话', selfSlot: null }
    const hero = mode === 'hero'
    // `?chat=5`：驾驶室「最近几条」要量五行（#170）：三行看不出行高是不是被长句撑开。
    if (query.get('chat') === '5') {
      const lines: { slot: number; label: string; relation: 'self' | 'teammate' | 'opponent'; text: string; at: number }[] = [
        { slot: 2, label: '我', relation: 'self', text: '我出跳刀了，开团喊我', at: now - 40_000 },
        { slot: 3, label: '队友 2', relation: 'teammate', text: '先别急，等我吼到三个再上，这波我们要一波带走对面，别再送了', at: now - 31_000 },
        { slot: 4, label: '队友 3', relation: 'teammate', text: '盾还有四十秒', at: now - 22_000 },
        { slot: 7, label: '对手 3', relation: 'opponent', text: 'gg', at: now - 13_000 },
        { slot: 8, label: '对手 4', relation: 'opponent', text: '中路推了', at: now - 4_000 }
      ]
      return {
        matchid: '7600111222',
        selfSlot: 2,
        line: '5 个人说过话',
        channels: lines.map((one) => ({
          slot: one.slot,
          label: one.label,
          relation: one.relation,
          hero: '',
          spoken: 1,
          lastAt: one.at,
          lastText: one.text,
          events: []
        }))
      }
    }
    return {
      matchid: '7600111222',
      selfSlot: 2,
      line: '3 个人说过话 · 我 1 句 · 队友 1 句 · 对手 2 句',
      channels: [
        {
          slot: 2,
          label: '我',
          relation: 'self',
          hero: hero ? 'nevermore' : '',
          spoken: 1,
          lastAt: now - 40_000,
          lastText: '我出跳刀了，开团喊我',
          events: []
        },
        {
          slot: 3,
          label: '队友 2',
          relation: 'teammate',
          hero: hero ? 'axe' : '',
          spoken: 1,
          lastAt: now - 25_000,
          lastText: '先别急，等我吼到三个再上，这波我们要一波带走对面',
          events: []
        },
        {
          slot: 7,
          label: '对手 3',
          relation: 'opponent',
          hero: hero ? 'lina' : '',
          spoken: 2,
          lastAt: now - 8_000,
          lastText: 'gg',
          events: []
        }
      ]
    }
  },
  holdSelfTest: async () => {
    // #95 预览：假边随刷新轮转。切换语音对讲模式的面板按钮会真的盖掉沉浸模式设置，
    // 退出预览再进 fresh browser 页面即还原。
    const mode = settings.voiceCaptureMode ?? 'hold'
    if (mode !== 'hold') {
      return { presence: 'off', ready: false, attempts: 0, fallbackReason: null, edges: [] }
    }
    // ?hold=fallback 看「常驻脚本起不来、退回敲一下」那一屏：这是最容易没人检查、
    // 却最需要人看见的状态（用户按住没反应，只能靠这一行告诉他）。
    if (query.get('hold') === 'fallback') {
      return {
        presence: 'fallback',
        ready: false,
        attempts: 5,
        fallbackReason: '常驻脚本连续 5 次没起来（按住的松开信号收不到）',
        edges: []
      }
    }
    const base = Date.now() - 30_000
    const edges = [
      { at: base + 1000, kind: 'press' as const },
      { at: base + 2600, kind: 'release' as const },
      { at: base + 8000, kind: 'press' as const },
      { at: base + 9600, kind: 'release' as const }
    ]
    return { presence: 'resident', ready: true, attempts: 0, fallbackReason: null, edges }
  },
  appVersion: async () => '0.0.0-stub',
  appOpenExternal: async () => ({ ok: true, error: null }),
  updateCheck: async () => ({ channel: 'stable', status: 'dev', version: '0.0.0' }),
  updateInstall: async () => true,
  // 诊断包（#111）：夹具假装收了 3 份、缺 2 份，好让面板的「缺哪几份」也走一遍。
  // 构建新鲜度（#113/#147）：默认「刚刚构建完」；?staleBuild=1 主进程源码更新（红字 + 徽标）；
  // ?rendererNewer=1 只有渲染层动过（一句话说明已热更新，不报警）。
  buildInfo: async () =>
    query.get('staleBuild') === '1'
      ? {
          stampMs: 1_763_000_000_000,
          bytes: 1_087_554,
          newestMainMs: 1_763_000_540_000,
          newestRendererMs: 1_763_000_000_000,
          stale: true,
          scope: 'main',
          note: '改的代码没生效：主进程源码比构建产物新 9 分，重跑 npm run dev:restart',
          behindMs: 540_000
        }
      : query.get('rendererNewer') === '1'
        ? {
            stampMs: 1_763_000_000_000,
            bytes: 1_087_554,
            newestMainMs: 1_763_000_000_000,
            newestRendererMs: 1_763_000_260_000,
            stale: false,
            scope: 'renderer',
            note: '渲染层有改动：开发模式下已经热更新，打包版才需要重新 npm run build',
            behindMs: null
          }
        : {
            stampMs: 1_763_000_540_000,
            bytes: 1_087_554,
            newestMainMs: 1_763_000_000_000,
            newestRendererMs: 1_763_000_000_000,
            stale: false,
            scope: null,
            note: '构建产物是最新的',
            behindMs: null
          },
  // 异常清单（P3）：`?errors=1` 造两条样本（一条未捕获、一条未处理 promise），默认干净。
  errorsView: async () =>
    query.get('errors') === '1'
      ? summarizeErrors([
          { at: '2026-11-21T12:00:04.000Z', kind: 'uncaught', message: 'Cannot read properties of undefined (reading push)', stack: null, context: 'translate:session' },
          { at: '2026-11-21T12:00:01.000Z', kind: 'uncaught', message: 'Cannot read properties of undefined (reading push)', stack: null, context: 'translate:session' },
          { at: '2026-11-21T11:58:20.000Z', kind: 'rejection', message: 'fetch failed: ECONNRESET', stack: null, context: 'provider' }
        ])
      : summarizeErrors([]),
  // 译文抽检（#87）：`?marks=1` 造三条样本，让「好评率」那一行在预览里看得见。
  phraseGroups: async () =>
    renderGroups(
      settings.quickPhrases,
      [{ name: '对线期', phrases: ['{hero} 别推线', '对面 {hero} 在哪'] }, { name: '空组', phrases: [] }],
      { hero: '影魔', time: '12:34', matchid: '7512345678' }
    ),
  providerBoard: async () =>
    summarizeProviderCalls([
      { at: '2026-11-21T12:00:00.000Z', providerId: 'deepseek', model: 'deepseek-chat', ok: true, ms: 820, kind: null },
      { at: '2026-11-21T12:00:01.000Z', providerId: 'deepseek', model: 'deepseek-chat', ok: false, ms: 30_000, kind: 'timeout' },
      { at: '2026-11-21T12:00:02.000Z', providerId: 'deepseek', model: 'deepseek-chat', ok: true, ms: 940, kind: null },
      { at: '2026-11-21T12:00:03.000Z', providerId: 'zhipu', model: 'glm-4-flash', ok: true, ms: 1230, kind: null }
    ]),
  probeCatalog: async () =>
    catalogOf([
      { flag: '--gsi-dump-report', summary: '读对局摘要', readOnly: true },
      { flag: '--match-report', summary: '折叠一局', readOnly: true },
      { flag: '--hotkey-probe', summary: '热键表', readOnly: true },
      { flag: '--gsi-dump', summary: '打印所有字段路径' }
    ]),
  translationMarks: async () =>
    summarizeMarks(
      query.get('marks') === '1'
        ? [
            { at: '2026-11-21T12:01:00.000Z', matchid: '7512345678', entryId: 'a1', source: '他中路不见了', translation: 'Mid is missing.', verdict: 'good', provider: 'deepseek', model: 'deepseek-chat', cached: false },
            { at: '2026-11-21T12:03:10.000Z', matchid: '7512345678', entryId: 'a2', source: '我们开雾', translation: 'We smoke.', verdict: 'bad', provider: 'deepseek', model: 'deepseek-chat', cached: false },
            { at: '2026-11-21T12:05:22.000Z', matchid: null, entryId: 'a3', source: '打肉山', translation: 'Roshan now.', verdict: 'good', provider: 'deepseek', model: 'deepseek-chat', cached: true }
          ]
        : []
    ),
  logBundleExport: async () => ({
    ok: true,
    path: 'data/logs/export/log-bundle-20260101-000000.zip',
    bytes: 18_432,
    files: 3,
    missing: ['voice-chain.jsonl', 'capture-ticks.jsonl'],
    error: null
  }),
  // 方向更正（#84）：桩里不翻，只回一个「按你点的方向重翻了」的假译文，好让面板走完整个显示路径。
  translateDirection: async (request) => ({
    ok: true,
    direction: request.direction,
    translated: request.direction === 'en-zh' ? '（桩）按英→中重翻的一句' : '(stub) retranslated the other way'
  }),
  // 周度质量卡（#110）：夹具给两段有数可看的样本，空日志那一支由探针管，预览不用。
  qualityReport: async () => ({
    guard: { caught: 3, recovered: 2, gaveUp: 1, tokens: [{ token: 'bkb', count: 2 }, { token: 'gg', count: 1 }] },
    cache: {
      snapshots: 4,
      pairs: 128,
      lifetimeHits: 512,
      hitRatio: 0.8,
      sessionHits: 12,
      sessionMisses: 8,
      sessionRatio: 0.6
    }
  }),
  // 麦克风健康（#96）：预览里没人开麦，上报渠道照走（这是个 send，不是 invoke）；?micDead=1 时先发一条掉线，面板那一行就有提示可看。
  reportMicHealth: () => {},
  onMicHealth: (cb) => {
    // ?micDead=1 看掉线提示；?micLive=1 看电平条（桩发一条 62% 的录音事件）。
    if (query.has('micDead')) setTimeout(() => cb({ recording: false, level: 0, dead: true, reason: 'ended', label: '麦克风 (Realtek(R) Audio)' }), 150)
    if (query.has('micLive')) setTimeout(() => cb({ recording: true, level: 62, dead: false, reason: null, label: '麦克风阵列 (Realtek(R) Audio)' }), 150)
    return () => {}
  },
  // #129：预览里给一份「丢过 3 段」的账，不然这一行在预览里永远是空态。
  voiceHalfDuplex: async () => ({
    playing: false,
    untilMs: 0,
    total: 41,
    dropped: Number(query.get('dropped') ?? 3),
    leg: 'unknown',
    penaltyMs: 0,
    line: '识别 41 段，其中 3 段是自己在说话时录到的，已丢弃'
  }),
  voicePlayback: () => undefined,
  // 语音队列（#88）：桩给一份「正在读 + 后头两句」的快照，停止回一句清掉了两条。
  speechQueue: async () => ({
    speaking: `你走中路,我下路`,
    pending: 2,
    lanes: [`你走中路,我下路`, `别急,等我跳刀`].map((text) => ({ key: `stub-${text.length}`, pending: text === `你走中路,我下路` ? 0 : 1, text }))
  }),
  onSpeechQueue: () => () => {},
  speechStop: async () => ({ cleared: 2, interrupted: true }),
  // #82：?pack=坏包 演示回退 + 警告，默认演示装好的一份包；点「内置」等于 apply('')。
  glossaryPacks: async () => glossaryStub(),
  // #81：设置包。默认演示「导出成功、导入成功」；?bundlePoor=1 演示整包被拒。
  settingsBundleExport: async () => ({
    ok: true,
    path: query.get('bundlePoor') === '1' ? null : 'data/export/settings-20260101-000000.zip',
    files: query.get('bundlePoor') === '1' ? 0 : 3,
    omitted: query.get('bundlePoor') === '1' ? [] : ['供应商 API Key', '各供应商 key 表', '代理地址'],
    error: query.get('bundlePoor') === '1' ? '写不进数据目录' : null
  }),
  settingsBundleImport: async () =>
    query.get('bundlePoor') === '1'
      ? { ok: false, applied: 0, kept: [], error: '这个包里没有 settings.json' }
      : { ok: true, applied: 12, kept: ['供应商 API Key'], error: null },
  glossaryApply: async (name: string) => glossaryStub(name),
  onUpdateStatus: (callback) => {
    callback({ channel: 'stable', status: 'dev', version: '0.0.0' })
    return () => {}
  },
  ttsOfflineState: async () => offlineState(),
  ttsOfflineDownload: async () => offlineState(),
  ttsPreview: async () => ({ ok: true }),
  // #176：四种失败各一条，句子照抄主进程那两张表（`src/main/services/reply/reply-service.ts:255,298` 与
  // `src/main/services/input/chat-inplace.ts:14`）——桩是演示"主进程会返回什么"，不是页面自己编文案。
  translateInPlace: async () => {
    const mode = query.get('send')
    if (mode === 'empty') return { ok: false, draft: null, translated: null, grabMs: 60, error: '聊天框里没有可翻译的内容', restored: false }
    if (mode === 'nofocus')
      return { ok: false, draft: null, translated: null, error: '游戏不在前台：先把 Dota 2 切到前台再按热键', restored: false }
    if (mode === 'write')
      return { ok: false, draft: '稳住，我们能赢', translated: 'hold mid, we can win', grabMs: 120, translateMs: 640, sendMs: 90, error: '写回聊天框并发送失败', restored: true }
    if (mode === 'keystroke')
      return { ok: false, draft: '稳住，我们能赢', translated: 'hold mid, we can win', grabMs: 130, translateMs: 610, sendMs: 420, error: '输入桥失败：SendInput 没送进去', restored: true }
    return {
      ok: true,
      draft: '稳住，我们能赢',
      translated: 'hold mid, we can win',
      grabMs: 120,
      translateMs: 640,
      sendMs: 95,
      restored: true
    }
  },
  panelSuggestions: async () => ({
    ok: true,
    items: ['Heading back to lane', 'Careful, mid is missing', 'Nice play']
  }),
  copyText: async () => true,
  chatHistory: async () => [
    {
      id: 'c1',
      ts: Date.now() - 60000,
      original: '[muerta] [队友] [队友A] ⚔ 雷锤还没出，跳刀也差一点',
      body: '雷锤还没出，跳刀也差一点',
      translated: 'mjollnir not ready yet',
      hero: 'muerta',
      keyNouns: ['跳刀'],
      direction: 'zh-en'
    }
  ],
  /**
   * 上手检查：桩里直接跑真判断（`judgeFirstRun` 是纯函数），只编造「主进程的现状」。
   * `?firstRun=empty` 让预览停在「空数据目录」那一屏——没这个开关，六步永远全是绿的，
   * 新用户看到的那一面就永远没人检查。
   */
  firstRunReport: async () => {
    const empty = query.get('firstRun') === 'empty'
    return judgeFirstRun({
      provider: {
        id: settings.provider.id,
        model: settings.provider.model,
        hasKey: !empty,
        lastTest: empty
          ? null
          : { providerId: settings.provider.id, model: settings.provider.model, ok: true, message: 'ok', latencyMs: 640 }
      },
      gsi: empty
        ? { configPath: null, configError: '没找到 Dota 2 安装目录（Steam 装在别的盘？）', lastAt: null, gameState: null }
        : { configPath: 'D:\\Steam\\steamapps\\common\\dota 2 beta\\game\\dota\\cfg\\gamestate_integration', configError: null, lastAt: Date.now() - 4000, gameState: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS' },
      asr: {
        ready: !empty,
        downloading: false,
        progress: 0,
        error: null,
        dir: 'C:\\stub\\data\\asr-models\\paraformer',
        expectedBytes: empty ? 227_330_205 + 75_354 : null
      },
      hotkeys: {
        rejected: hotkeyPayload().actions.filter((action) => action.verdict === 'rejected').map((action) => ({ label: action.label, display: action.display })),
        total: hotkeyPayload().actions.length
      },
      dataDir: 'C:\\stub\\data',
      now: Date.now()
    })
  },
  /**
   * 这台机器：桩里也跑真判据（`judgeEnv` 纯函数），只编造主进程能量的和省心假值。
   * `?mach=warn` 切到「内存偏紧 + 端口空闲、被别人占了不知道」那一屏。
   */
  envReport: async (devices) => {
    // `?mach=tight` 只造「内存偏紧」：仰头（#175）在就绪态要显示「另有 N 项提醒」，
    // 没有这个开关那一行永远出不来——warn 不许因为「不降级」就从界面上消失。
    const tightMode = query.get('mach') === 'tight'
    const warnMode = query.get('mach') === 'warn'
    return judgeEnv({
      cpuModel: 'Intel(R) Core(TM) i7-10750H CPU @ 2.60GHz',
      cpuCores: 12,
      freeMemBytes: tightMode || warnMode ? 1_073_741_824 : 5_642_354_688,
      totalMemBytes: 17_179_869_184,
      diskFreeBytes: 123_456_543_232,
      diskTotalBytes: 512_110_190_592,
      diskPath: 'C:\\stub\\data',
      gsiPort: 32123,
      portOwner: warnMode ? 'other' : 'ours',
      micCount: devices?.micCount ?? 1,
      speakerCount: devices?.speakerCount ?? 1
    })
  },
  /**
   * #78 Steam 库选择器：桩里也跑真判据（`resolveGsiRoot` 纯函数）。
   * `?libs=2` 造两个库、选的是非常用那个（面板才显示选择器）；`?libs=missing` 造「选的库没了」。
   */
  gsiLibraries: async () => {
    const mode = query.get('libs')
    const two = mode === '2' || mode === 'missing'
    const roots = two
      ? [
          { root: 'C:\\Program Files (x86)\\Steam', hasDota: true },
          { root: 'D:\\SteamLibrary', hasDota: true }
        ]
      : [{ root: 'C:\\Program Files (x86)\\Steam', hasDota: true }]
    const chosen = mode === 'missing' ? 'E:\\Moved\\SteamLibrary' : two ? 'D:\\SteamLibrary' : ''
    return { roots, chosen, resolve: resolveGsiRoot(roots, chosen) }
  },
  gsiSetLibrary: async (root) => ({
    ok: true,
    path: `${
      root !== '' ? root : 'C:\\Program Files (x86)\\Steam'
    }\\steamapps\\common\\dota 2 beta\\game\\dota\\cfg\\gamestate_integration\\gamestate_integration_ohmydota2.cfg`
  }),
  captureStatus: async () => {
    const stalled = query.get('stall') === '1' || overviewMode === 'stalled'
    const lastAt = stalled ? Date.now() - 7 * 60_000 : Date.now() - 4_000
    return {
      running: !stalled,
      source: 'gsi',
      totalEntries: 37,
      lastTranslateMs: 820,
      lastError: null,
      gsi: {
        listening: true,
        port: 32123,
        gameState: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS',
        matchId: '7512345678',
        lastAt,
        autoStarts: 2,
        autoStops: 1,
        configPath: 'D:/Steam/steamapps/common/dota 2 beta/game/dota/cfg/gamestate_integration',
        configError: null,
        roster: [],
        rosterText: '',
        // ?stall=1 停在「有过一局、然后帧停了」那一屏：这是用户唯一真正需要看见它的时刻。
        stall: stalled
          ? { state: 'stalled', silentMs: 7 * 60_000, warning: gsiStallWarning(7 * 60_000), action: 'restart-dota' }
          : judgeGsiStall({ live: true, lastAt, now: Date.now() })
      }
    }
  },
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
  asrModels: async () => ({ activeId: stubAsrActiveId, pinned: true, models: [...stubAsrModels] }),
  asrActiveSet: async (id) => {
    stubAsrActiveId = id
    settings.asrActiveModel = id
    return { activeId: id, pinned: true, models: [...stubAsrModels] }
  },
  hotwordSuggestions: async () => stubHotwordView(),
  hotwordApply: async (words) => {
    const plan = mergePlan(settings.asrHotwords, words)
    if (plan.added.length > 0) settings.asrHotwords = plan.next
    // 真机把处理过的词从池子里摘掉，表满丢下的词留着（否则「删几个再勾上重并」无从谈起）；
    // 预览跟随同一口径，连点两次「并入」才不会重复报数。
    const handled = new Set([...plan.added, ...plan.already])
    stubHotwordPool = stubHotwordPool.filter((item) => !handled.has(item.word))
    return { ...plan, hotwords: settings.asrHotwords }
  },
  hotwordDismiss: async (words) => {
    stubHotwordPool = stubHotwordPool.filter((item) => !words.includes(item.word))
    return stubHotwordView()
  },
  voiceRuntimeStatus: async () => ({ state: 'ready', nodePath: 'stub-node.exe', installing: false, installError: null }),
  voiceRuntimeInstall: async () => ({ ok: true, error: null }),
  voiceModelRemove: async () => ({ ok: true, error: null }),
  onVoiceRuntimeState: () => () => {},
  onVoiceChainResult: (cb) => {
    // `?voiceDemo` 才有结果：预览页平时保持安静，要看待机态不该被一条假记录占位。
    // 只发一次：StrictMode 会挂两次监听，发两次就成了同一毫秒的两行（记录行按 at 做 key）。
    if (query.has('voiceDemo') && !chainDemoSent) {
      chainDemoSent = true
      setTimeout(() => cb(stubVoiceChain), 120)
    }
    return () => {}
  },
  onVoiceRecordState: () => () => {},
  voiceOutTest: async () => ({ ok: true, durationMs: 900, hint: 'stub 声出已播', sinkLabel: 'CABLE Input (VB-Audio Virtual Cable)' }),
  // #90 三种缺口一眼可看：?cable=absent（没装）/ driverOnly（驱动在端点没出现）/ error（没查成）。
  voiceOutCable: async () => {
    const mode = query.get('cable')
    if (mode === 'absent') return { installed: false, endpoints: [], driverOnly: false, error: null }
    if (mode === 'driverOnly') return { installed: true, endpoints: [], driverOnly: true, error: null }
    if (mode === 'error') return { installed: false, endpoints: [], driverOnly: false, error: 'PowerShell 超过 15 秒没返回' }
    return {
      installed: true,
      endpoints: ['CABLE Input (VB-Audio Virtual Cable)', 'CABLE Output (VB-Audio Virtual Cable)'],
      driverOnly: false,
      error: null
    }
  },
  voiceOutCableInstall: async () => ({ ok: true, launched: true, dir: 'C:\\data\\vb-cable', step: null, error: null }),
  overlayVoiceToggle: async () => ({ ok: true }),
  trainRuns: async () => stubTrainRuns,
  trainRun: async (id) => stubTrainRuns.find((run) => run.id === id) ?? null,
  trainSnapshot: async () => stubTrainSnapshot,
  // 训练日志：预览里给一段真格式的样例，只有当天的行会被压成 HH:mm:ss。
  trainLog: async ({ limit }) => {
    const lines = [
      '[2026-11-09T13:40:48.101Z] —— 开始训练：增量微调 · 41 条进训练 + 2 条留验证（共 43 条，132 秒音频）——',
      '[2026-11-09T13:40:48.104Z] 第 1 条：G14-L01「我的跳刀还没好」',
      '[2026-11-09T13:40:48.106Z] 最后一条：G20-L12「对面在偷盾，快回来」',
      '[2026-11-09T13:40:48.109Z] 轮数 18 · 学习率 1e-5 · 起点 data/asr-ft-runs/ft-20261109133221/checkpoint-176',
      '[2026-11-09T13:41:02.412Z] {"loss": 0.0004, "grad_norm": 0.037, "learning_rate": 9.9e-06, "epoch": 6.61}',
      '[2026-11-09T13:41:08.918Z] {"loss": 0.0003, "grad_norm": 0.041, "learning_rate": 9.4e-06, "epoch": 11.39}',
      '[2026-11-09T13:43:52.503Z] 完成（已换上新模型）',
      '[2026-11-09T13:43:52.510Z] 本轮训练 41 条 + 验证 2 条；账本里还剩 0 条待训'
    ]
    return { path: 'data/logs/train.log', bytes: lines.join('\n').length, lines: lines.slice(-(limit ?? 400)), truncated: false }
  },
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
  // 预览里的编辑保存只改内存：真写盘只有 Electron 里才有，但抽屉的往返能照着看。
  ftScriptSave: async (groups) => {
    stubScript.groups = groups as typeof stubScript.groups
    stubScript.source = 'data'
    stubScript.path = 'data/asr-ft-script.md'
    stubScript.warning = null
    return stubScript
  },
  ftScriptReset: async () => stubScript,
  // `?asr=nodata`：一句都没录时体检才报「数据不足」，桩里得连录音一起空掉（#173）。
  ftRecList: async () => (asrStub === 'nodata' ? [] : [...stubRecs]),
  ftRecSave: async (group, line, bytes) => {
    // 预览里也真的「存下」：保存后列表带上新标记，自动前进才有东西可看。
    const info = stubTake(
      `${group}-${line}`,
      bytes.length,
      Math.max(400, Math.round((bytes.length / 32_000) * 1000)),
      Date.now()
    )
    const index = stubRecs.findIndex((rec) => rec.key === info.key)
    if (index >= 0) stubRecs[index] = info
    else stubRecs.push(info)
    return info
  },
  ftRecDelete: async (group, line) => {
    const key = `${group}-${line}`
    const index = stubRecs.findIndex((rec) => rec.key === key)
    if (index >= 0) stubRecs.splice(index, 1)
  },
  ftRecRead: async () => new Uint8Array(0),
  ftRecAsr: async () => ({ ok: true, text: '预览里没有真识别引擎' }),
  // 纠错样本（#66）：预览里没有真录音可存，点「存」只让上面那一行涨一条。
  voiceCorrection: async ({ corrected }: { corrected: string }) => {
    if (!corrected.trim()) return { saved: false, key: null, notice: '改对的那句是空的：这次没存纠错样本' }
    stubCorrections.push({ bytes: 96_000 })
    return { saved: true, key: `G01-T${String(stubCorrections.length).padStart(2, '0')}`, notice: null }
  },
  ftDatasetPrepare: async () => ({
    ok: true,
    trainCount: 38,
    evalCount: 4,
    trainPath: 'data/asr-ft-runs/stub/dataset/train.jsonl',
    evalPath: 'data/asr-ft-runs/stub/dataset/eval.jsonl',
    ledger: [],
    skippedCorrections: [],
    error: null
  }),
  // 全量识别比对：预览里给一份「已跑完」的结果，点开就能看到不一致长什么样。
  asrCheckStart: async () => stubAsrCheck,
  asrCheckStop: async () => stubAsrCheck,
  asrCheckState: async () => stubAsrCheck,
  asrCheckCorrect: async (key, text) => {
    const clean = String(text ?? '').trim()
    if (clean === '') return { ok: false, error: '改完的句子不能是空的' }
    stubAsrCheck = {
      ...stubAsrCheck,
      items: stubAsrCheck.items.map((item) => (item.key === key ? { ...item, expected: clean } : item))
    }
    return { ok: true, revision: 2 }
  },
  ftAsrftStatus: async () => {
    const engine = stubFinetuneEngine()
    const finetune = engine.finetune as NonNullable<AsrEngineSpec['finetune']>
    // 账本只含逐句组录音：录/删一条，步数与分钟都动（与真实现共用 estimateFtCost）。
    const lineRecs = stubLineRecs()
    // 待训数字跟着预览里的录音集走：录一条（ftRecSave）这里就涨，删一条就掉。
    // 与真账本同口径：自由说组没有标准答案，不进账本也不进待训。
    const pending = summarizePendingTakes({
      entries: lineRecs.map((rec) => ({
        key: rec.key,
        revision: 1,
        bytes: rec.bytes,
        runId: null as string | null
      })),
      hasRun: true
    })
    const costInput = {
      trainer: finetune.trainer,
      takes: lineRecs.length,
      audioMs: lineRecs.reduce((sum, rec) => sum + rec.durationMs, 0),
      lastStep: 0,
      pendingTakes: pending.count,
      pendingAudioMs: pending.durationMs
    }
    const estimate = {
      fresh: estimateFtCost({ ...costInput, mode: 'fresh' }),
      incremental: estimateFtCost({ ...costInput, mode: 'incremental' })
    }
    const stubbed = {
      env: { ok: true, gaps: [] as string[], envRoot: 'data/asr-ft-env' },
      // 目标行跟着现役模型走：?asrModel=paraformer 切腿时 trainer 一起换，估时不会对不上。
      target: {
        engineId: engine.id,
        label: engine.label,
        trainer: finetune.trainer,
        modelDir: `data/${engine.canonicalRel}`,
        baseModel: finetune.baseModelIds[0] ?? finetune.baseModelDirs[0] ?? '',
        // 底模副本（#69）：预览给一份齐的，让「重置为底模」按钮可点；?asrModel= 切腿时目录名一起走。
        baseCopy: { dir: `data/asr-models/${engine.canonicalRel.split('/').pop()}-base`, ready: true, missing: [] }
      },
      swap: { activeExists: true, bakExists: true, nextExists: false, lastExportDir: 'ft-stub' },
      coverage: { G14: { done: 3, total: 6, stale: 0 }, G15: { done: 1, total: 8, stale: 1 } },
      pending,
      estimate,
      estimateBasis: estimate.fresh.basis,
      // 纠错样本（#66）：预览里点「存」假存一条，这一行跟着涨（真的写盘只有 Electron 里才有）。
      corrections: judgeCorrectionSamples(stubCorrections),
      install: null,
      // 预览里挑两句「稿子改了但没重录」的样本，好让琥珀色行与增量置灰看得见。
      scriptStale: ['G14-L02', 'G14-L05'],
      // 数据体检（#104）：预览里给一份「录了但没有声音」的样本，让健康告警和时长分布看得见。
      health: {
        takes: 6,
        duration: { minMs: 620, medianMs: 900, maxMs: 2200, totalMs: 6800 },
        issues: [
          { kind: 'unusable' as const, label: '1 条录不出话（静音 1）', keys: ['G14-L02'], detail: 'G14-L02 静音' },
          { kind: 'missing' as const, label: '稿子里还有 2 句没录', keys: ['G15-L04', 'G15-L07'], detail: 'G15-L04、G15-L07' }
        ],
        ok: false
      }
    }
    // `?asr=` 的四种「上去就问用户要东西」的处境：缺环境 / 一句都没录 / 增量没有起点 / 现役已就位。
    if (asrStub === 'env') stubbed.env = { ok: false, gaps: ['torch 2.5 未安装', 'soundfile 缺失'], envRoot: stubbed.env.envRoot }
    if (asrStub === 'nodata') {
      stubbed.swap = { ...stubbed.swap, activeExists: false, bakExists: false }
      stubbed.pending = { ...stubbed.pending, count: 0, label: '还没录过：从未训练' }
    }
    if (asrStub === 'live') stubbed.pending = { ...stubbed.pending, count: 0, label: '没有待训数据' }
    return stubbed
  },
  ftAsrftInstall: async () => ({ running: false, stage: 'done', progress: 1, error: null }),
  ftAsrftApply: async () => ({ ok: true, error: null, model: 'ft-stub' }),
  ftAsrftSkipAudition: async () => ({ ok: true, error: null, model: 'ft-stub' }),
  // `?patch=1`：预览里摆一行「游戏里出现了我们还不认识的」；默认是健康状态（line 为 null）。
  patchWatch: async () =>
    query.get('patch') === '1'
      ? { frames: 240, gaps: 2, line: '游戏里出现了我们还不认识的：map.clock_time、muerta 等 2 项', at: '2026-11-09T13:40:48.101Z' }
      : { frames: 240, gaps: 0, line: null, at: '2026-11-09T13:40:48.101Z' },
  ftAsrftRollback: async () => ({ ok: true, error: null, model: null }),
  ftAsrftResetBase: async () => ({ ok: true, error: null, model: null }),
  ftAsrftFacts: async () => ({ vramNote: null, incremental: asrStub !== 'no-base' && asrStub !== 'nodata' }),
  sovitsStatus: async () => sovitsStatus,
  sovitsInstall: async () => sovitsStatus,
  sovitsRefs: async () => sovitsRefs,
  sovitsVoicepacks: async () =>
    packsAllInstalled
      ? sovitsPacks.map((pack) => ({ ...pack, installed: true, installedVersion: pack.version, haveBytes: pack.bytes, upgradable: false }))
      : sovitsPacks,
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
  // `?warn=1` 造一条断链告警：没有它，「看这台机器」这个入口在预览里永远看不到（#140）。
  voiceOutReadiness: async () =>
    overviewMode !== 'ok' && (query.get('warn') === '1' || overviewMode === 'notready')
      ? {
          ready: false,
          reason: 'service-down',
          line: 'GV 服务没在跑：点「启动服务」再试，起不来看下面那行的原因',
          action: 'start-service'
        }
      : {
          ready: true,
          reason: null,
          line: 'GV 就绪：引擎、音色包、服务、参考音频都在',
          action: null
        },
  onVoiceOutReadiness: () => () => {},
  // #80 影子模式：`?shadow=done` 看「第一局已打完」、`?shadow=off` 看关掉的样子。
  voiceOutShadow: async () => {
    const state = query.get('shadow') === 'off' ? 'off' : query.get('shadow') === 'done' ? 'done' : 'active'
    const report =
      state === 'active'
        ? {
            count: 3,
            chars: 42,
            newest: new Date().toISOString(),
            sample: [
              { at: new Date().toISOString(), matchid: '7512345678', text: '小心 gank，对面辅助不见了' },
              { at: new Date().toISOString(), matchid: '7512345678', text: '买个粉，他们有个隐身' }
            ]
          }
        : state === 'done'
          ? { count: 7, chars: 96, newest: new Date().toISOString(), sample: [] }
          : { count: 0, chars: 0, newest: null, sample: [] }
    return shadowView(state, report)
  },
  // 看一眼（#135）：桩要返回「不是函数的清理器」会被 React 当成 destroy，
  // 整个面板因此白屏（TypeError: destroy is not a function）——这里一次补齐三条。
  visionState: async () => ({ ready: false, model: '预览桩', reason: '预览里没有真实模型' }),
  visionAsk: async () => ({
    ok: false,
    text: '',
    model: '预览桩',
    providerId: 'stub',
    ms: null,
    shot: null,
    error: '预览桩：不真截屏，也不调用模型'
  }),
  onVisionResult: () => () => {},
  overlayStatus: async () => overlaySnap(),
  // 驾驶室第二片（#165）：时间线的局号默认与快照一致；?crossMatch=1 让它是别的局，?emptyTimeline=1 空表。
  matchTimeline: async () => {
    if (query.has('emptyTimeline')) return { matchid: '7600111222', entries: [], line: '这局还没有值得停一下的事' }
    const own = query.has('crossMatch') ? '7512345678' : '7600111222'
    return {
      matchid: own,
      entries: [{ id: 'wisdom@420', kind: 'wisdom', gameTime: 420, text: '智慧符刷新了', done: false }],
      line: '这局 1 件：还欠 1 件'
    }
  },
  matchTimelineDone: async () => stubMatchTimeline(),
  // 说话按钮：?captureBusy=1 模拟被 500 ms 去抖挡回来（界面必须说一句，不能静默）。
  voiceCaptureToggle: async () => ({ sent: !query.has('captureBusy') }),
  // 驾驶室第三片（#167）：最后一条对讲。默认是「这一局刚说过一句」；四个开关各演一种没得看。
  voiceChainLast: async () => {
    if (query.has('chainNull')) return null
    const summary = {
      transcript: '对面中单不见了，小心 gank',
      translated: 'Their mid is missing, careful of a gank.',
      spoken: true,
      stage: null,
      error: null,
      sink: 'CABLE Input (VB-Audio Virtual Cable)'
    }
    if (query.has('chainCross')) return { matchid: '7512345678', summary }
    if (query.has('chainNoMatch')) return { matchid: null, summary }
    if (query.has('chainFail')) {
      return {
        matchid: '7600111222',
        summary: { ...summary, spoken: false, stage: 'voice-out', sink: undefined, error: '声出失败：Edge 返回 0 字节。这一行故意很长，用来验证界面只保留第一句并截断，后面的细节不该进面板。' }
      }
    }
    return { matchid: '7600111222', summary }
  },

  overlayPanelToggle: async () => {
    overlay.panelOpen = !overlay.panelOpen
    return overlaySnap()
  },
  onOverlayState: (callback) => {
    callback(overlaySnap())
    return () => {}
  },
  // 浮层预览要的那几条推送原来没有桩：Proxy 兜底返回的是 async 函数，effect 拿到 Promise 就直接报错，
  // 整个浮层页渲染不出来（看着像「空白」）。这里一次补齐，缺的那条会立刻在控制台点名。
  onCaptureEntries: (callback) => {
    if (!query.has('noRows')) setTimeout(() => callback(stubOverlayEntries()), 120)
    return () => {}
  },
  onCaptureReplace: () => () => {},
  onCaptureUpdate: (callback) => {
    // 只有 ?late=1 才补一条译文：平时保持「原文已到、译文还没来」的样子。
    if (query.has('late')) setTimeout(() => callback([{ ...stubOverlayEntries()[1], translated: '中路不见了', pending: false }]), 600)
    return () => {}
  },
  onVoiceRecordStart: () => () => {},
  onVoiceRecordStop: () => () => {},
  onVoiceRecordToggle: () => () => {},
  onVoiceSpeak: () => () => {},
  onVoiceStage: () => () => {},
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
  },
  // 三档字号（#100）：改完把 status 回给面板，按钮的选中态跟着走。
  overlaySetFont: async (size) => {
    overlay.fontSize = size
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
