import { app, BrowserWindow, globalShortcut, session } from 'electron'

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
import { join } from 'node:path'
import { runInputProbe } from './probes/input'
import { captureHint } from '@shared/overlay-hint'
import { warmEdge } from './services/voice/edge'
import { ensureSovitsServer, stopSovitsServer } from './services/voice/sovits-server'
import { autoVoicePackSetup } from './services/voice/sovits-voicepack'
import { runTtsBenchProbe } from './probes/tts-bench'
import { runTtsOfflineProbe } from './probes/tts-offline'
import { runTtsVoicesProbe } from './probes/tts-voices'
import { runTtsPlayProbe } from './probes/tts-play'
import { runGsiProbe } from './probes/gsi'
import { runSettingsPersistProbe } from './probes/settings-persist'
import { runGsiDumpProbe } from './probes/gsi-dump'
import { runGsiFramesReportProbe } from './probes/gsi-frames-report'
import { runSovitsRefsProbe } from './probes/sovits-refs'
import { runSovitsVoicepackProbe } from './probes/sovits-voicepack'
import { runMatchReportProbe } from './probes/match-report'
import { runTranslateCacheProbe } from './probes/translate-cache'
import { startGsi, stopGsi } from './services/gsi'
import { startUpdateCheck } from './services/updater'
import { registerIpc, translateInPlace } from './ipc'
import { installProxyAwareFetch } from './services/session/net-fetch'
import { runChatBlockProbe } from './probes/chat-block'
import { runInPlaceProbe, runReplyLatencyProbe } from './probes/latency'
import { runOverlayGeometryProbe } from './probes/overlay-geometry'
import { loadSettings } from './services/settings'
import { warmTranslator } from './services/session/durable-translator'
import { suppressExperimentalSqliteWarning } from './services/session/warnings'
import { getOverlayManager } from './windows/overlay'
import { getCaptureService } from './services/capture/capturer'
import { getInPlaceSender } from './services/input/chat-inplace'
import { createTray, destroyTray } from './windows/tray'
import { applyPortableUserData } from './services/data-dir'

// 数据目录必须在任何 userData 读取之前定好：settings、会话库、日志、词库都挂在它下面。
applyPortableUserData()

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
    void dashboard.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void dashboard.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showDashboard())
}

app.whenReady().then(() => {
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
  if (process.argv.includes('--overlay-geometry-probe')) void runOverlayGeometryProbe()
  if (process.argv.includes('--input-probe')) void runInputProbe()

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
  globalShortcut.register('Alt+Shift+O', () => {
    getOverlayManager().toggle()
  })
  // 锁定/解锁：锁定后浮层不吃鼠标；解锁后能拖动、拉两侧改宽度，拖完再锁定。
  globalShortcut.register('Alt+Shift+P', () => {
    const overlay = getOverlayManager()
    if (overlay.status().visible) overlay.setLocked(!overlay.status().locked)
  })
  // 收起/展开小图标：收起后如果是锁定状态就穿透点不到，只能靠这个热键收回来。
  globalShortcut.register('Alt+Shift+B', () => {
    const overlay = getOverlayManager()
    if (overlay.status().visible) overlay.toggleCollapse()
  })
  // 直发：inplace = 读游戏聊天框草稿 → 翻译 → 粘回并回车；其他通道 = 弹浮层输入框。
  globalShortcut.register('Alt+Shift+T', () => {
    if (loadSettings().sendMode === 'inplace') void translateInPlace()
    else getOverlayManager().openReply()
  })
  globalShortcut.register('Alt+Shift+V', () => {
    getOverlayManager().toggleVoiceCapture()
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
            lastError: capture.lastError
          })
        )
      } catch {
        // 计时器不该把主进程拖垮：拿不到状态就当没有提示。
      }
    }, 2000)
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createDashboard()
  })
})

// Keep running in the tray; quitting happens through the tray menu.
app.on('window-all-closed', () => {})

app.on('will-quit', () => {
  quitting = true
  globalShortcut.unregisterAll()
  stopGsi()
  stopSovitsServer()
  destroyTray()
  getInPlaceSender().dispose()
  getOverlayManager().destroy()
})