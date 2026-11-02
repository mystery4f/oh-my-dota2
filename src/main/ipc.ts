import { BrowserWindow, app, ipcMain } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IPC, ipcContract, type MainHandlers } from '@shared/ipc'
import { sendReply, translateInPlace, translateReplyToClipboard, voiceReply } from './services/reply/reply-service'
import { loadSettings, saveSettings } from './services/settings'
import { translationInsights } from './services/session/translate-cache'
import { checkForUpdates, installUpdate } from './services/updater'
import { testProvider, translateText } from './services/providers'
import { sessionStatus, translateTry } from './services/session/durable-translator'
import { getCaptureService } from './services/capture/capturer'
import { getWhisperAdapter } from './services/voice/whisper'
import { getVoiceOutService } from './services/voice/voice-out'
import { getTtsAdapter } from './services/voice/tts'
import { ensureOfflineModel, offlineStatus } from './services/voice/offline'
import { ensureQwen3Model, qwen3Status, qwen3Transcribe } from './services/voice/qwen3-asr'
import { ensureSovitsInstall } from './services/voice/sovits-install'
import { activateSovitsRef, ensureSovitsServer, sovitsStatusSnapshot } from './services/voice/sovits-server'
import { listSovitsRefs, sovitsRefsRoot, sovitsWeightsRoot } from './services/voice/sovits-refs'
import { autoVoicePackSetup, deleteVoicePack, ensureSovitsSeedRef, installVoicePack, sovitsVoicePacks } from './services/voice/sovits-voicepack'
import { getOverlayManager } from './windows/overlay'
import { getTrainWindow } from './windows/train'
import { getTrainManager } from './services/train/manager'
import { ftRecDelete, ftRecList, ftRecPath, ftRecRead, ftRecSave, readFtScript } from './services/train/ft-record'
import { prepareFtDataset } from './services/train/ft-dataset'
import {
  applyAsrFtModel,
  asrFtStatus,
  buildAsrFtExportPlan,
  resolveAsrFtTrainRequest,
  rollbackAsrFtModel
} from './services/train/asr-ft'
import { asrFtInstallState, installAsrFtEnv } from './services/train/asr-ft-install'
import { normalizeTrainKind } from '@shared/train'
import { gsiStatus } from './services/gsi'


/** 主进程 → 所有窗口的广播（面板按钮状态、语音链回显都靠它活着）。 */
const broadcast = (channel: string, payload: unknown): void => {
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
}

/**
 * 契约 handler 表（#30）：每条 invoke/send 通道一行，签名由 MainHandlers 钉死；
 * listen 通道是主进程推送侧，不进这张表。注册循环在 registerIpc 里。
 */
const handlers: MainHandlers = {
  // 设置 / 提供商 / 翻译
  getSettings: () => loadSettings(),
  setSettings: (patch) => saveSettings(patch),
  testProvider: (provider) => testProvider(provider),
  translate: (text, direction) =>
    translateTry(loadSettings().provider, text, direction ?? 'en-zh').catch(() =>
      // 会话层失败时退回直连，保证「翻译试用」永远能给出结果或明确报错。
      translateText(loadSettings().provider, text, direction ?? 'en-zh')
    ),
  translateReply: (text, tone) => translateReplyToClipboard(text, tone),
  sendReply: (text) => sendReply(text),
  translateInPlace: () => translateInPlace(),
  translatorStatus: () => sessionStatus(),
  cacheStats: () => translationInsights(),
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
    // 面板按钮与 Alt+Shift+V 共用同一条录制链：起录/停录都由 overlay 窗口自己报状态。
    getOverlayManager().toggleVoiceCapture()
    return { ok: true }
  },
  overlaySetText: (mode) => getOverlayManager().setText(mode),
  overlayOpenReply: () => getOverlayManager().openReply(),
  overlayCloseReply: (submitted) => getOverlayManager().closeReply(Boolean(submitted)),
  overlayReplyState: () => getOverlayManager().status(),
  overlaySetGeometry: (patch) => getOverlayManager().applyGeometry(patch ?? {}),
  overlayResetGeometry: () => getOverlayManager().resetGeometry(),
  overlaySetVoice: (read) => getOverlayManager().setVoice(Boolean(read)),
  overlayToggleCollapse: () => getOverlayManager().toggleCollapse(),
  overlayKeepAlive: () => getOverlayManager().keepAlive(),
  overlayNudge: (dx, dy) => getOverlayManager().nudge(dx, dy),
  overlaySnap: () => getOverlayManager().snap(),
  overlaySetLocked: (locked) => getOverlayManager().setLocked(locked),
  overlaySetOpacity: (value) => getOverlayManager().setOpacity(value),
  voiceReply: (transcript) => voiceReply(String(transcript ?? '')),
  // overlay 起录/停录/出结果时上抛，广播给所有窗口（面板按钮与回显行靠它活着）。
  reportVoiceState: (recording) => {
    broadcast(IPC.VOICE_RECORD_STATE, { recording: Boolean(recording) })
  },
  reportVoiceChain: (result) => {
    broadcast(IPC.VOICE_CHAIN_RESULT, result)
  },
  whisperProbe: (binPath) => getWhisperAdapter().probe(String(binPath ?? '')),
  whisperSetup: () =>
    getWhisperAdapter().ensureAssets((phase, pct) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IPC.VOICE_WHISPER_PROGRESS, { phase, pct })
      }
    }),
  transcribeAudio: async (wavBase64, language) => {
    const base64 = String(wavBase64 ?? '')
    if (!base64) return { ok: false, text: '', error: '音频为空' }
    const dir = join(app.getPath('userData'), 'voice')
    mkdirSync(dir, { recursive: true })
    const wavPath = join(dir, 'utterance.wav')
    writeFileSync(wavPath, Buffer.from(base64, 'base64'))
    // 识别引擎路由：Qwen3 走 sherpa worker；模型没就绪时给一句人话提示，
    // 让用户去面板下载/解压，而不是吞掉录音。
    const asrEngine = loadSettings().asrEngine
    if (asrEngine === 'qwen3') {
      if (!qwen3Status().ready) {
        return {
          ok: false,
          text: '',
          error: 'Qwen3 模型未就绪：下载 tar.bz2 放进 data\\asr-models\\，到面板「识别引擎」点解压'
        }
      }
      return qwen3Transcribe(wavPath).then((result) =>
        result ? { ok: true, text: result.text } : { ok: false, text: '', error: 'Qwen3 识别失败' }
      )
    }
    return getWhisperAdapter().transcribe(wavPath, language ?? 'zh')
  },
  ttsPreview: (text) => getTtsAdapter().preview(String(text ?? '')),
  voiceOutTest: () => getVoiceOutService().test(),
  ttsOfflineState: () => offlineStatus(),
  ttsOfflineDownload: () => ensureOfflineModel(),
  asrStatus: () => qwen3Status(),
  asrDownload: () => ensureQwen3Model(),
  // GPT-SoVITS：面板每 3 秒问一次「包在不在、服务起没起、最近日志」，不再靠翻控制台猜。
  sovitsStatus: () => sovitsStatusSnapshot(),
  // 一键安装：.7z 已放数据目录就只解压；否则下 8GB 再解压。装完顺手把服务拉起来，
  // 再把默认音色包拉齐（三件套 → refs.json → 自动选中）。
  sovitsInstall: async () => {
    const state = await ensureSovitsInstall()
    void ensureSovitsServer()
    if (state.phase === 'ready') void autoVoicePackSetup()
    return sovitsStatusSnapshot()
  },
  // 参考音频库：读数据根下 tts/sovits-refs/refs.json，坏条目与缺失音频已在纯函数里滤掉。
  sovitsRefs: () =>
    listSovitsRefs(sovitsRefsRoot(app.getPath('userData')), sovitsWeightsRoot(app.getPath('userData'))),
  // 音色包：目录 + 本地状态一张表；安装 = 下载三件套 → refs.json 落条目 →（没选过音色）自动选中。
  sovitsVoicepacks: () => sovitsVoicePacks(),
  sovitsVoicepackInstall: (id) => installVoicePack(String(id ?? '')),
  sovitsVoicepackDelete: (id) => deleteVoicePack(String(id ?? '')),
  // 选定一条参考：统一走主进程「写设置 → 切权重 → 预热」，且只认库里真实存在的条目。
  sovitsSelectRef: async (entry) => {
    const known = listSovitsRefs(
      sovitsRefsRoot(app.getPath('userData')),
      sovitsWeightsRoot(app.getPath('userData'))
    ).find((item) => item.audioPath === entry.audioPath)
    return known ? activateSovitsRef(known) : false
  },
  // 首启保底：库一条参考都没有时，用 Edge 现场合成一条晓晓参考入库（零分发）。
  sovitsSeed: () => ensureSovitsSeedRef(false),
  // 训练管理（T1）：窗口开关 + 任务启停 + 快照订阅；互斥与计划推导都在 manager/纯缝里。
  trainOpen: () => getTrainWindow().open(),
  trainStart: async (request) => {
    if (normalizeTrainKind(request.kind) !== 'asr-ft') return getTrainManager().start(request)
    // asr-ft：先把环境/数据/目录备齐，再带着「训练完接导出」的链子交给 manager。
    const resolved = await resolveAsrFtTrainRequest(String(request.dataset ?? ''))
    if (!resolved.ok || !resolved.request) return { ok: false, error: resolved.error ?? '微调任务备料失败' }
    const exportRequest = resolved.request
    return getTrainManager().start(exportRequest, () => buildAsrFtExportPlan(exportRequest))
  },
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
    const wavPath = ftRecPath(String(group ?? ''), String(line ?? ''))
    if (loadSettings().asrEngine === 'qwen3') {
      if (!qwen3Status().ready) {
        return { ok: false, text: '', error: 'Qwen3 模型未就绪：到面板「识别引擎」里点解压' }
      }
      const result = await qwen3Transcribe(wavPath)
      return result ? { ok: true, text: result.text } : { ok: false, text: '', error: 'Qwen3 识别失败' }
    }
    return getWhisperAdapter().transcribe(wavPath, 'zh')
  },
  // 一键打包：录音 × 稿子 → 官方微调 JSONL（#14 的核心件，试点格式已验证）。
  ftDatasetPrepare: () => prepareFtDataset(),
  // ASR 微调闭环（T5）：环境状态、应用新模型、回滚。
  ftAsrftStatus: async () => ({ ...(await asrFtStatus()), install: asrFtInstallState() }),
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
}
