import { app, clipboard, ipcMain } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { errorMessage } from '@shared/errors'
import { IPC, ipcContract, type MainHandlers } from '@shared/ipc'
import { translateInPlace, voiceReply } from './services/reply/reply-service'
import { generatePanelSuggestions } from './services/reply/panel-suggestions'
import { loadSettings, saveSettings } from './services/settings'
import { hotkeysState, saveHotkeysState } from './services/hotkeys'
import { translationInsights } from './services/session/translate-cache'
import { checkForUpdates, installUpdate } from './services/updater'
import { testProvider, translateText } from './services/providers'
import { clearTranslationCache, inspectTranslationCache, sessionStatus, translateTry } from './services/session/durable-translator'
import { getCaptureService } from './services/capture/capturer'
import { getVoiceOutService } from './services/voice/voice-out'
import { getTtsAdapter } from './services/voice/tts'
import { ensureOfflineModel, offlineStatus } from './services/voice/offline'
import { transcribeWav } from './services/voice/asr'
import { saveVoiceCorrection, stashUtterance } from './services/voice/corrections'
import {
  asrState,
  asrStatus,
  ensureActiveAsrModel,
  removeActiveAsrModel,
  setActiveAsrModel
} from './services/voice/asr-model'
import {
  installVoiceRuntime,
  voiceRuntimeInstallState,
  voiceRuntimeNodeBinary,
  voiceRuntimeState,
  onVoiceRuntimeProgress
} from './services/voice/runtime'
import { ensureSovitsInstall } from './services/voice/sovits-install'
import { activateSovitsRef, ensureSovitsServer, sovitsStatusSnapshot } from './services/voice/sovits-server'
import { onVoiceOutReadiness, refreshVoiceOutReadiness } from './services/voice/voice-out-readiness'
import { listSovitsRefs, sovitsRefsRoot, sovitsWeightsRoot } from './services/voice/sovits-refs'
import {
  autoVoicePackSetup,
  deleteVoicePack,
  ensureSovitsSeedRef,
  installVoicePack,
  selectVoicePack,
  sovitsVoicePacks
} from './services/voice/sovits-voicepack'
import { getOverlayManager } from './windows/overlay'
import { broadcastToWindows as broadcast } from './windows/broadcast'
import { listTrainRuns, loadTrainRun } from './services/train/run-store'
import { getTrainManager } from './services/train/manager'
import { ftRecDelete, ftRecList, ftRecPath, ftRecRead, ftRecSave, readFtScript } from './services/train/ft-record'
import { prepareFtDataset } from './services/train/ft-dataset'
import {
  applyAsrFtModel,
  asrFtFacts,
  asrFtStatus,
  buildAsrFtExportPlan,
  resolveAsrFtTrainRequest,
  rollbackAsrFtModel
} from './services/train/asr-ft'
import { asrFtInstallState, installAsrFtEnv } from './services/train/asr-ft-install'
import { closeGvWebui, openGvWebui, registerGvWeights, resolveGvTrainRequest, scanGvDatasets } from './services/train/gv'
import { discoverSovitsHome } from './services/voice/sovits-server'
import { normalizeTrainKind } from '@shared/train/task'
import { normalizeAsrFtMode } from '@shared/train/asr-ft'
import { gsiStatus } from './services/gsi'



/** 明确的 GV 动作之后立刻重算就绪：3 秒 tick 只是兜底，点了按钮必须当场翻牌。 */
function refreshReadinessAfter<T>(job: Promise<T>): Promise<T> {
  void job.then(
    () => refreshVoiceOutReadiness(),
    () => refreshVoiceOutReadiness()
  )
  return job
}

/**
/** 语音运行时状态快照：handler 表与广播共用同一份拼装，别处不要再各拼一份。 */
function runtimeStatusSnapshot() {
  return {
    state: voiceRuntimeState(),
    nodePath: voiceRuntimeNodeBinary(),
    ...voiceRuntimeInstallState()
  }
}

/** 契约 handler 表（#30）：每条 invoke/send 通道一行，签名由 MainHandlers 钉死； */
const handlers: MainHandlers = {
  // 设置 / 提供商 / 翻译
  getSettings: () => loadSettings(),
  // 存完设置顺手重算声出就绪：换引擎、换参考音频都得让对讲页那一行立刻翻牌。
  setSettings: (patch) => {
    const next = saveSettings(patch)
    void refreshVoiceOutReadiness()
    return next
  },
  getHotkeys: () => hotkeysState(),
  // 存完热键要重发一次浮层状态：浮层和自己那行提示上的键名都来自 status()，
  // 不重发就会出现「键改了、浮层还在教旧键」，直到下一次状态变化。
  setHotkeys: (map) => {
    const result = saveHotkeysState(map)
    if (!result.error) getOverlayManager().refreshStatus()
    return result
  },
  testProvider: (provider) => testProvider(provider),
  translate: (text, direction) =>
    translateTry(loadSettings().provider, text, direction ?? 'en-zh').catch(() =>
      // 会话层失败时退回直连，保证「翻译试用」永远能给出结果或明确报错。
      translateText(loadSettings().provider, text, direction ?? 'en-zh')
    ),
  translateInPlace: () => translateInPlace(),
  panelSuggestions: () => generatePanelSuggestions(),
  translatorStatus: () => sessionStatus(),
  cacheStats: () => translationInsights(),
  // 清空缓存两步走：inspect 数数给确认框，clear 才真删（都只对当前 provider）。
  translationCacheInspect: () => inspectTranslationCache(),
  translationCacheClear: () => clearTranslationCache(),
  // 捕获账本与更新
  captureStart: () => getCaptureService().start(),
  captureStop: () => getCaptureService().stop(),
  captureStatus: () => ({ ...getCaptureService().status(), gsi: gsiStatus() }),
  appVersion: () => app.getVersion(),
  updateCheck: () => checkForUpdates(),
  updateInstall: () => installUpdate(),
  // 浮层：面板与热键共用同一条链
  overlayToggle: () => getOverlayManager().toggle(),
  overlayVoiceToggle: () => {
    // 面板按钮与「语音对讲」共用同一条录制链：起录/停录都由 overlay 窗口自己报状态。
    getOverlayManager().toggleVoiceCapture()
    return { ok: true }
  },
  overlaySetText: (mode) => getOverlayManager().setText(mode),
  overlayPanelToggle: () => getOverlayManager().togglePanel(),
  overlayStatus: () => getOverlayManager().status(),
  chatHistory: () => getCaptureService().history(),
  overlaySetGeometry: (patch) => getOverlayManager().applyGeometry(patch ?? {}),
  overlayResetGeometry: () => getOverlayManager().resetGeometry(),
  overlaySetVoice: (read) => getOverlayManager().setVoice(Boolean(read)),
  overlayToggleCollapse: () => getOverlayManager().toggleCollapse(),
  overlayKeepAlive: () => getOverlayManager().keepAlive(),
  overlayNudge: (dx, dy) => getOverlayManager().nudge(dx, dy),
  overlaySnap: () => getOverlayManager().snap(),
  overlaySetLocked: (locked) => getOverlayManager().setLocked(locked),
  overlaySetOpacity: (value) => getOverlayManager().setOpacity(value),
  copyText: (text) => {
    clipboard.writeText(String(text ?? ''))
    return true
  },
  voiceReply: (transcript) => voiceReply(String(transcript ?? '')),
  // overlay 起录/停录/出结果时上抛，广播给所有窗口（面板按钮与回显行靠它活着）。
  reportVoiceState: (recording) => {
    broadcast(IPC.VOICE_RECORD_STATE, { recording: Boolean(recording) })
  },
  reportVoiceChain: (result) => {
    broadcast(IPC.VOICE_CHAIN_RESULT, result)
  },
  transcribeAudio: async (wavBase64) => {
    const base64 = String(wavBase64 ?? '')
    if (!base64) return { ok: false, text: '', error: '音频为空' }
    const dir = join(app.getPath('userData'), 'voice')
    mkdirSync(dir, { recursive: true })
    const wavPath = join(dir, 'utterance.wav')
    const wav = Buffer.from(base64, 'base64')
    writeFileSync(wavPath, wav)
    // 引擎路由在这里只有一行：识别引擎的选择与「模型没就绪」的提示都由 transcribeWav 负责。
    const result = await transcribeWav(wavPath)
    // #66：这句的原音留在内存里，并把票据（utteranceId）随结果交给渲染层——语音页纠错在
    // 另一个窗口、时间也更晚，而 utterance.wav 下一句就被覆盖了。票据而不是文本：同一句说两遍
    // 文本一样、录音不同，按文本找会把较新那段音配到较旧那一行上。
    if (!result.ok || !result.text.trim()) return result
    const utteranceId = stashUtterance(result.text, wav)
    return utteranceId ? { ...result, utteranceId } : result
  },
  // #66：纠错落库。开关（settings.asrCorrectionsToDataset）在主进程判；面板只报「票据 + 改对的那句」。
  voiceCorrection: (input) => saveVoiceCorrection(input),
  ttsPreview: (text) => getTtsAdapter().preview(String(text ?? '')),
  voiceOutTest: () => getVoiceOutService().test(),
  ttsOfflineState: () => offlineStatus(),
  ttsOfflineDownload: () => ensureOfflineModel(),
  asrStatus: () => asrStatus(),
  asrDownload: () => ensureActiveAsrModel(),
  // 模型注册表：换模型只改一个 id；钉完顺带杀掉常驻 worker，下一次转写用新目录。
  asrModels: () => asrState(),
  asrActiveSet: (id) => setActiveAsrModel(String(id ?? '')),
  // 语音运行时（#45）：状态即时算；安装是长任务，结束后广播一次终态。
  voiceRuntimeStatus: () => runtimeStatusSnapshot(),
  voiceRuntimeInstall: async () => {
    try {
      await installVoiceRuntime()
      broadcast(IPC.VOICE_RUNTIME_STATE, runtimeStatusSnapshot())
      return { ok: true, error: null }
    } catch (err) {
      const message = errorMessage(err)
      broadcast(IPC.VOICE_RUNTIME_STATE, runtimeStatusSnapshot())
      return { ok: false, error: message }
    }
  },
  voiceModelRemove: () => removeActiveAsrModel(),
  // GPT-SoVITS：面板每 3 秒问一次「包在不在、服务起没起、最近日志」，不再靠翻控制台猜。
  sovitsStatus: () => sovitsStatusSnapshot(),
  // 一键安装：.7z 已放数据目录就只解压；否则下 8GB 再解压。装完顺手把服务拉起来，
  // 再把默认音色包拉齐（三件套 → refs.json → 自动选中）。
  sovitsInstall: async () => {
    const state = await ensureSovitsInstall()
    void ensureSovitsServer()
    if (state.phase === 'ready') void autoVoicePackSetup()
    void refreshVoiceOutReadiness()
    return sovitsStatusSnapshot()
  },
  // 参考音频库：读数据根下 tts/sovits-refs/refs.json，坏条目与缺失音频已在纯函数里滤掉。
  sovitsRefs: () =>
    listSovitsRefs(sovitsRefsRoot(app.getPath('userData')), sovitsWeightsRoot(app.getPath('userData'))),
  // 音色包：目录 + 本地状态一张表；安装 = 下载三件套 → refs.json 落条目 →（没选过音色）自动选中。
  sovitsVoicepacks: () => sovitsVoicePacks(),
  sovitsVoicepackInstall: (id) => refreshReadinessAfter(installVoicePack(String(id ?? ''))),
  sovitsVoicepackDelete: (id) => refreshReadinessAfter(deleteVoicePack(String(id ?? ''))),
  // 选音频色包（朗读页同样能直接选）：条目与激活都在主进程里定，渲染层不碰 refs.json。
  sovitsSelectPack: (id) => refreshReadinessAfter(selectVoicePack(String(id ?? ''))),
  // 选定一条参考：统一走主进程「写设置 → 切权重 → 预热」，且只认库里真实存在的条目。
  sovitsSelectRef: async (entry) => {
    const known = listSovitsRefs(
      sovitsRefsRoot(app.getPath('userData')),
      sovitsWeightsRoot(app.getPath('userData'))
    ).find((item) => item.audioPath === entry.audioPath)
    // 这一步正是清掉 refs-missing 的动作，但它在主进程里直接 saveSettings，
    // 走不到 setSettings 的刷新钩子，所以必须在这里自己补一次。
    return known ? refreshReadinessAfter(activateSovitsRef(known)) : false
  },
  // 首启保底：库一条参考都没有时，用 Edge 现场合成一条晓晓参考入库（零分发）。
  sovitsSeed: () => refreshReadinessAfter(ensureSovitsSeedRef(false)),
  // #46 就绪行：首屏读一次，之后靠广播（判断只有一份，在 shared 纯缝里）。
  voiceOutReadiness: () => refreshVoiceOutReadiness(),
  // 幂等启动：服务已在跑就直接返回现状。拉起要 15–40 秒，这里不 await——
  // 面板先看到「正在启动」，就绪由广播翻牌，不会卡住一次点击。
  sovitsStartServer: async () => {
    void ensureSovitsServer()
    void refreshVoiceOutReadiness()
    return sovitsStatusSnapshot()
  },
  // 训练管理（v3）：记录落盘，面板两页从磁盘读；互斥与计划推导都在 manager/纯缝里。
  trainRuns: () => listTrainRuns(),
  trainRun: (id) => loadTrainRun(id),
  trainStart: async (request) => {
    const kind = normalizeTrainKind(request.kind)
    // gv-*：先把引擎包/底模/数据集/配置文件备齐，缺口在这里就报出来，不进 manager。
    if (kind === 'gv-gpt' || kind === 'gv-sovits') {
      const resolved = resolveGvTrainRequest(request)
      return resolved.ok && resolved.request
        ? getTrainManager().start(resolved.request)
        : { ok: false, error: resolved.error ?? 'GV 训练备料失败' }
    }
    if (kind !== 'asr-ft') return getTrainManager().start(request)
    // asr-ft：先把环境/数据/目录备齐，再带着「训练完接导出」的链子交给 manager。
    // 开训方式（从底模重训 / 接着上次权重）原样落到 run 记录；增量接不上就拒启动，不静默落回重训。
    const resolved = await resolveAsrFtTrainRequest(normalizeAsrFtMode(request.mode))
    if (!resolved.ok || !resolved.request) return { ok: false, error: resolved.error ?? '微调任务备料失败' }
    const exportRequest = resolved.request
    return getTrainManager().start(exportRequest, () => buildAsrFtExportPlan(exportRequest), resolved.warning)
  },
  trainGvDatasets: () => {
    const home = discoverSovitsHome()
    return home ? scanGvDatasets(home) : []
  },
  trainGvWebui: ({ open }) => {
    const result = open ? openGvWebui() : closeGvWebui()
    return { ...result, running: open }
  },
  trainGvRegister: (payload) => registerGvWeights(payload),
  trainStop: () => getTrainManager().stop(),
  trainSnapshot: () => getTrainManager().snapshot(),
  // ASR 微调录音（T4a）：读稿解析 + 录音 CRUD，文件全在 userData/asr-ft/ 下。
  ftScriptRead: () => readFtScript(),
  ftRecList: () => ftRecList(),
  ftRecSave: (group, line, data) => ftRecSave(group, line, data),
  ftRecDelete: (group, line) => ftRecDelete(group, line),
  ftRecRead: (group, line) => ftRecRead(group, line),
  // 训练窗口「识别测试」：已存录音直接喂给当前识别引擎，和稿子原文对比。
  ftRecAsr: async (group, line) => {
    return transcribeWav(ftRecPath(String(group ?? ''), String(line ?? '')))
  },
  // 一键打包：录音 × 稿子 → 官方微调 JSONL（#14 的核心件，试点格式已验证）。
  ftDatasetPrepare: () => prepareFtDataset(),
  // ASR 微调闭环（T5）：环境状态、应用新模型、回滚。
  ftAsrftStatus: async () => ({ ...(await asrFtStatus()), install: asrFtInstallState() }),
  // 开训闸门看到的事实：显存提示与「上次能不能续训」，panel 只显示不自己推。
  ftAsrftFacts: () => asrFtFacts(),
  // 启动即回，装到哪一步看 STATUS 轮询（整套装下来要十几分钟）。
  ftAsrftInstall: async () => {
    void installAsrFtEnv()
    return asrFtInstallState()
  },
  ftAsrftApply: () => applyAsrFtModel(),
  ftAsrftRollback: () => rollbackAsrFtModel()
}

export function registerIpc(): void {
  // 注册循环：契约表整表一遍过。新增通道 = 契约加一行 + handler 表加一行，别处零改动。
  for (const [name, def] of Object.entries(ipcContract)) {
    const handler = (handlers as Record<string, (...args: unknown[]) => unknown>)[name]
    if (def.kind === 'invoke') ipcMain.handle(def.channel, (_event, ...args: unknown[]) => handler(...args))
    else ipcMain.on(def.channel, (_event, ...args: unknown[]) => handler(...args))
  }
  // 契约表之外的主进程接线：训练快照广播（listen 通道的推送侧）。
  getTrainManager().onState((snapshot) => broadcast(IPC.TRAIN_STATE, snapshot))
  // 语音运行时安装进度：主进程推、面板翻状态牌（面板不装事件重复订阅的轮询）。
  onVoiceRuntimeProgress(() => broadcast(IPC.VOICE_RUNTIME_STATE, runtimeStatusSnapshot()))
  // #46：就绪快照变了才广播（纯缝已去过重），面板订阅即翻牌，不再自己开定时器。
  onVoiceOutReadiness((snapshot) => broadcast(IPC.VOICE_OUT_READINESS_STATE, snapshot))
}
