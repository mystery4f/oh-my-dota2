import { app, BrowserWindow, session } from 'electron'
import { errorMessage } from '@shared/errors'

// 隐藏抓屏窗口必须持续出帧：Chromium 默认会节流被遮挡/后台的渲染进程，视频流会冻住。
app.commandLine.appendSwitch('disable-backgrounding-occluded-windows')
app.commandLine.appendSwitch('disable-renderer-backgrounding')
app.commandLine.appendSwitch('disable-background-timer-throttling')
// Dota 2 全屏独占时 WGC 抓屏会持续报 ProcessFrame failed 并回退到旧帧（OCR 拿到的是冻结画面），
// 关掉 WGC 让它走 DXGI/GDI 桌面复制路径。
app.commandLine.appendSwitch('disable-features', 'AllowWgcScreenCapturer')
// 朗读是「程序自己放音频」：Chromium 默认要求先有用户手势，否则 play() 直接被拒。
// 表现为「朗读开了但一点声音都没有」，日志里只有一条被吞掉的 NotAllowedError。
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { captureHint } from '@shared/overlay-hint'
import { warmEdge } from './services/voice/edge'
import { ensureSovitsServer, stopSovitsServer } from './services/voice/sovits-server'
import { autoVoicePackSetup } from './services/voice/sovits-voicepack'
import { runTtsBenchProbe } from './probes/tts-bench'
import { runTtsOfflineProbe } from './probes/tts-offline'
import { runTtsPlayProbe } from './probes/tts-play'
import { runTtsPipelineProbe } from './probes/tts-pipeline'
import { runTtsVoicesProbe } from './probes/tts-voices'
import { runGsiProbe } from './probes/gsi'
import { runSettingsPersistProbe } from './probes/settings-persist'
import { runGsiDumpProbe } from './probes/gsi-dump'
import { runGsiFramesReportProbe } from './probes/gsi-frames-report'
import { runSovitsRefsProbe } from './probes/sovits-refs'
import { runSovitsVoicepackProbe } from './probes/sovits-voicepack'
import { runMatchReportProbe } from './probes/match-report'
import { runTranslateCacheProbe } from './probes/translate-cache'
import { runTranslateAccuracyProbe } from './probes/translate-accuracy'
import { startGsi, stopGsi } from './services/gsi'
import { startUpdateCheck } from './services/updater'
import { registerIpc } from './ipc'
import { installProxyAwareFetch } from './services/session/net-fetch'
import { refreshVoiceOutReadiness } from './services/voice/voice-out-readiness'
import { runChatBlockProbe } from './probes/chat-block'
import { runInPlaceProbe, runReplyLatencyProbe } from './probes/latency'
import { runOverlayGeometryProbe } from './probes/overlay-geometry'
import { runHotkeyProbe } from './probes/hotkeys'
import { runHoldWatchProbe } from './probes/hold-watch'
import { runVoiceOutProbe } from './probes/voice-out'
import { runAsrSwapProbe } from './probes/asr-swap'
import { runInPlaceGuardProbe } from './probes/inplace-guard'
import { runAsrHotwordsProbe } from './probes/asr-hotwords'
import { runAsrEnginesProbe } from './probes/asr-engines'
import { runProviderReasoningProbe } from './probes/provider-reasoning'
import { runZhipuLiveProbe } from './probes/zhipu-live'
import { runTrainProbe } from './probes/train'
import { runVoiceRuntimeProbe } from './probes/voice-runtime'
import { loadSettings } from './services/settings'
import { hotkeysState, installHotkeys, releaseHotkeys } from './services/hotkeys'
import { warmTranslator } from './services/session/durable-translator'
import { translateInPlace } from './services/reply/reply-service'
import { suppressExperimentalSqliteWarning } from './services/session/warnings'
import { getOverlayManager } from './windows/overlay'
import { getCaptureService } from './services/capture/capturer'
import { getInPlaceSender } from './services/input/chat-inplace'
import { createTray, destroyTray } from './windows/tray'
import { applyPortableUserData } from './services/data-dir'

// 数据目录必须在任何 userData 读取之前定好：settings、会话库、日志、词库都挂在它下面。
applyPortableUserData()

// 诊断用：强制渲染进程暴露无障碍树，让 UI 自动化能看到网页层焦点（长期开着无副作用）。
app.commandLine.appendSwitch('force-renderer-accessibility')
suppressExperimentalSqliteWarning()

let dashboard: BrowserWindow | null = null
let quitting = false

/**
 * The proxy is meant for foreign traffic only. Provider endpoints are usually
 * domestic, and tunnelling them through an HTTP/2 proxy lets answer streams of
 * other clients on the same proxy get mixed in, so they always go direct.
 */
function proxyBypassRules(): string {
  const host = providerHost(loadSettings().provider.baseUrl)
  return ['<-loopback>', 'localhost', '127.0.0.1', ...(host ? [host, '*.' + host] : [])].join(',')
}

function providerHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname
  } catch {
    return ''
  }
}

function applyProxy(proxyUrl: string): void {
  if (!proxyUrl) return
  session.defaultSession
    .setProxy({
      mode: 'fixed_servers',
      proxyRules: `http=${proxyUrl};https=${proxyUrl}`,
      proxyBypassRules: proxyBypassRules()
    })
    .catch((err) => console.error('main: setProxy failed', err))
}

/** Show the dashboard, recreating it if it was destroyed. */
function showDashboard(): void {
  if (!dashboard) createDashboard()
  if (!dashboard) return
  if (dashboard.isMinimized()) dashboard.restore()
  dashboard.show()
  dashboard.focus()
}

function createDashboard(): void {
  dashboard = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 960,
    minHeight: 680,
    title: 'oh-my-dota2',
    backgroundColor: '#0c0a09',
    // 原生标题栏 + 菜单栏是「难看」的主要来源：换成覆盖式标题栏，
    // 保留系统的三颗按钮（自绘它们要跟 Win10/11 各版本对齐，不值当）。
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0c0a09', symbolColor: '#e7e5e4', height: 38 },
    show: false,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true
    }
  })
  dashboard.on('close', (event) => {
    if (quitting) return
    event.preventDefault()
    dashboard?.hide()
  })
  dashboard.on('closed', () => {
    dashboard = null
  })
  // 配 show:false：等第一帧渲染好再显示，避免白底闪一下（深色界面尤其明显）。
  dashboard.once('ready-to-show', () => dashboard?.show())

  if (process.env.ELECTRON_RENDERER_URL) {
    // Dev-only: OMD2_QUERY appends a query string to the renderer URL so a panel
    // section can be opened directly (`set OMD2_QUERY=s=talk` before `npm run dev`).
    // Nothing sets it in a packaged build.
    const query = process.env.OMD2_QUERY
    void dashboard.loadURL(query ? `${process.env.ELECTRON_RENDERER_URL}?${query}` : process.env.ELECTRON_RENDERER_URL)
  } else {
    void dashboard.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

const probeFlag = process.argv.find((arg) => arg.startsWith('--') && arg.endsWith('-probe'))
if (!app.requestSingleInstanceLock()) {
  if (probeFlag) {
    // 单实例锁被开发版占着时，探针会静默退场（exit 0、没有 PASS 行），看的人只会当成「过了」。
    console.error(
      `PROBE_BLOCKED: single-instance lock held by another electron instance — ${probeFlag} cannot run. ` +
        'Close the app first (powershell Stop-Process -Name electron -Force), then rerun.',
    )
    app.exit(2)
  }
  app.quit()
} else {
  app.on('second-instance', () => showDashboard())
}

app.whenReady().then(() => {
  // 构建戳：用 bg_run 起的 dev 会随 electron 一起退出，watcher 停了之后窗口还在，很容易把旧构建当新代码。
  // 改完主进程代码先看这行的时间是否变化，再决定要不要重启。
  try {
    const built = __filename
    const stat = statSync(built)
    console.log('BUILD_STAMP', JSON.stringify({ at: stat.mtime.toISOString(), bytes: stat.size }))
  } catch (error) {
    console.log('BUILD_STAMP', JSON.stringify({ error: errorMessage(error) }))
  }
  installProxyAwareFetch()
  applyProxy(loadSettings().proxyUrl)
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) =>
    callback(permission === 'media')
  )
  registerIpc()
  createDashboard()
  createTray({
    showDashboard,
    quit: () => {
      quitting = true
      app.quit()
    }
  })
  // 任何 --xxx-probe / --xxx-selftest 都算探针；--tts-bench 不是「probe」结尾，但它同样不该抢 GSI 端口。
  const probeRun = process.argv.some(
    (arg) => arg.startsWith('--') && (arg.endsWith('-probe') || arg.endsWith('-selftest') || arg === '--tts-bench')
  )
  if (process.argv.includes('--inplace-probe')) void runInPlaceProbe()
  if (process.argv.includes('--reply-latency-probe')) void runReplyLatencyProbe()
  if (process.argv.includes('--tts-bench')) void runTtsBenchProbe()
  if (process.argv.includes('--tts-offline-probe')) void runTtsOfflineProbe()
  if (process.argv.includes('--tts-voices-probe')) void runTtsVoicesProbe()
  if (process.argv.includes('--tts-pipeline-probe')) void runTtsPipelineProbe()
  if (process.argv.includes('--tts-play-probe')) void runTtsPlayProbe()
  if (process.argv.includes('--chat-block-probe')) void runChatBlockProbe()
  if (process.argv.includes('--gsi-probe')) void runGsiProbe()
  if (process.argv.includes('--settings-persist-probe')) void runSettingsPersistProbe()
  if (process.argv.includes('--sovits-refs-probe')) void runSovitsRefsProbe()
  if (process.argv.includes('--sovits-voicepack-probe')) void runSovitsVoicepackProbe()
  if (process.argv.includes('--gsi-dump')) void runGsiDumpProbe()
  if (process.argv.includes('--gsi-dump-report')) void runGsiFramesReportProbe()
  if (process.argv.includes('--match-report')) void runMatchReportProbe()
  if (process.argv.includes('--translate-cache-probe')) void runTranslateCacheProbe()
  if (process.argv.includes('--translate-accuracy-probe')) void runTranslateAccuracyProbe()
  if (process.argv.includes('--overlay-geometry-probe')) void runOverlayGeometryProbe()
  if (process.argv.includes('--hotkey-probe')) void runHotkeyProbe()
  if (process.argv.includes('--hold-watch-probe')) void runHoldWatchProbe()
  if (process.argv.includes('--voice-out-probe')) void runVoiceOutProbe()
  if (process.argv.includes('--asr-hotwords-probe')) void runAsrHotwordsProbe()
  if (process.argv.includes('--provider-reasoning-probe')) void runProviderReasoningProbe()
  if (process.argv.includes('--zhipu-live-probe')) void runZhipuLiveProbe()
  if (process.argv.includes('--train-probe')) void runTrainProbe()
  if (process.argv.includes('--voice-runtime-probe')) void runVoiceRuntimeProbe()
  if (process.argv.includes('--asr-engines-probe')) void runAsrEnginesProbe()
  if (process.argv.includes('--inplace-guard-probe')) void runInPlaceGuardProbe()
  if (process.argv.includes('--asr-swap-probe')) void runAsrSwapProbe()

  const startup = loadSettings()
  // 进对局自动开始处理聊天：GSI 报 GAME_IN_PROGRESS 时会再拉一次，这里覆盖「启动时已在局内」。
  if (!probeRun && startup.autoStartCapture) getCaptureService().start()
  // 预热翻译会话：冷启动的建库与会话创建放在后台，用户第一条消息就是热路径。
  if (!probeRun) void warmTranslator(startup.provider)
  // 朗读预热：实测冷握手 1–21 秒、热连接 1–2 秒，开机就把两条连接握好。
  if (!probeRun) warmEdge()
  // GPT-SoVITS：模型加载约 40s，选了这个引擎就趁没人说话先把服务拉起来。
  // 开机自起 sovits 服务，同时把默认音色包补齐：三件套下载/落 refs.json 都不需要引擎在场，
  // 引擎还没装的用户也能先把 230MB 拉好，装完引擎即刻可用。
  if (!probeRun && startup.ttsEngine === 'sovits') {
    void ensureSovitsServer()
    void autoVoicePackSetup()
  }
  // 原地直发要两次往返游戏窗口：常驻 PowerShell 桥在后台先起好，省掉每次 600ms 的启动与 Add-Type 编译。
  if (!probeRun) void getInPlaceSender().prewarm()
  // GSI：本地状态源，进对局自动开捕获、打完自动停，并把 player.name 记进 myNicknames。
  if (!probeRun) void startGsi()
  // 浮层显示/收起/锁定跨启动还原（2026-10-28「记忆收起、锁定、隐藏」）：
  // 锁定与收起由设置字段带回来；这里只补「上次退出时亮着」的那一半。
  if (!probeRun && startup.overlayVisible) getOverlayManager().show()
  // 更新：装好的包里开机静默查一次，有就自己下，下完把「重启」挂在面板上等用户点。
  if (!probeRun) startUpdateCheck()
  // 全局热键：处理函数只交一次，键本身来自设置表（面板可改）。
  // 抢不到不炸只记：别的软件（剪辑工具/输入法/游戏助手）占了这个键时，
  // 用户按了没反应，面板里能直接看到是哪一个动作被占了。
  // 探针不装整表：按键监视是常驻进程，装了会覆盖探针自己那一路（--hold-watch-probe 就靠它）。
  if (!probeRun) installHotkeys({
    overlayToggle: () => {
      getOverlayManager().toggle()
    },
    // 锁定/解锁：锁定后浮层不吃鼠标；解锁后能拖动、拉两侧改宽度，拖完再锁定。
    overlayLock: () => {
      const overlay = getOverlayManager()
      if (overlay.status().visible) overlay.setLocked(!overlay.status().locked)
    },
    // 收起/展开小图标：收起后如果是锁定状态就穿透点不到，只能靠这个热键收回来。
    overlayCollapse: () => {
      const overlay = getOverlayManager()
      if (overlay.status().visible) overlay.toggleCollapse()
    },
    // 呼出面板：浮层临时变成可交互面板（历史/快捷短语/AI 建议），再按一次关闭。
    overlayPanel: () => {
      const overlay = getOverlayManager()
      if (overlay.status().visible) overlay.togglePanel()
    },
    // 原地直发：读游戏聊天框草稿 → 翻译 → 粘回并回车。
    inplaceSend: () => {
      // 热键这条路径没人接返回值：真出了没处理过的错也要说一句，不能静默地「按了没反应」。
      void translateInPlace().catch((err: unknown) => {
        getOverlayManager().flashHint('直发失败：' + (errorMessage(err)))
      })
    },
    voiceCapture: () => {
      getOverlayManager().toggleVoiceCapture()
    },
    // 按住模式：按下开录、松开触发，两次按键之间没有 toggle 的去抖窗口。
    voiceCaptureStart: () => {
      getOverlayManager().startVoiceCapture()
    },
    voiceCaptureStop: () => {
      getOverlayManager().stopVoiceCapture()
    }
  })

  // 浮层上只留「为什么没字」一行提示：正常时它是空的，异常时由它替用户回答。
  if (!probeRun) {
    setInterval(() => {
      try {
        const capture = getCaptureService().status()
        const overlay = getOverlayManager()
        if (!overlay.status().visible) return
        overlay.setHint(
          captureHint({
            running: capture.running,
            gsiLive:
              capture.gsi?.gameState === 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS' ||
              capture.gsi?.gameState === 'DOTA_GAMERULES_STATE_PRE_GAME',
            lastError: capture.lastError,
            // 提示里点名当前配置的键：用户改了键，这条提示不能还在教旧键。
            toggleKey: hotkeysState().actions.find((item) => item.id === 'overlayToggle')?.display
          })
        )
      } catch {
        // 计时器不该把主进程拖垮：拿不到状态就当没有提示。
      }
    }, 2000)
  }

  // #46 声出就绪：外部起的 GV 服务、被外部杀掉的进程只能靠探测发现，
  // 3 秒一轮足够快；快照相等不广播，空刷不会惊动面板。
  if (!probeRun) {
    setInterval(() => {
      void refreshVoiceOutReadiness()
    }, 3000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createDashboard()
  })
})

// Keep running in the tray; quitting happens through the tray menu.
app.on('window-all-closed', () => {})

app.on('will-quit', () => {
  quitting = true
  releaseHotkeys()
  stopGsi()
  stopSovitsServer()
  destroyTray()
  getInPlaceSender().dispose()
  getOverlayManager().destroy()
})
