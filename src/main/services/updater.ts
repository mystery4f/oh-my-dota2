import { app, BrowserWindow } from 'electron'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { autoUpdater } from 'electron-updater'
import { IPC, type UpdateState } from '@shared/ipc'

/**
 * 检查更新 / 下载 / 重启安装。
 *
 * 只在装好的包里成立：`autoUpdater` 要读 `resources/app-update.yml`，而那份文件是
 * electron-builder 打包时按 `publish` 配置写进去的。开发模式直接返回 `dev`，
 * 免得每次 `npm run dev` 都去 GitHub 拉一次 latest.yml 然后报一个没人关心的错。
 *
 * 通道策略：Nightly 包只跟 Nightly，正式包只跟正式版。
 * 判据是版本号里有没有 `-nightly.`（Nightly 流水线会把它写进去），而不是打包时的环境变量——
 * 装到用户机器上以后，唯一还活着的信息就是 app.getVersion()。
 * Nightly 会读 `nightly.yml`、允许预发布；正式包读 `latest.yml`、拒绝预发布。
 * 另外 `allowDowngrade = false`：Nightly 的语义版本低于同号正式版，不关掉这一条，
 * 一次「检查更新」就能把它偷偷降级回 v1.0.0。
 */
/**
 * 打包后的应用没有控制台：更新失败如果只 console.log，用户和你都看不到。
 * 所以每条更新事件都追加进 `data/logs/updater.log`，面板点一次就能回头看。
 */
function logUpdate(event: string, detail: unknown = ''): void {
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    const line = JSON.stringify({ at: new Date().toISOString(), event, detail })
    appendFileSync(join(dir, 'updater.log'), line + String.fromCharCode(10))
  } catch {
    // 记日志失败不能反过来影响更新流程。
  }
}

const CHANNEL: 'nightly' | 'stable' = app.getVersion().includes('-nightly.') ? 'nightly' : 'stable'

let state: UpdateState = { channel: CHANNEL, status: 'idle', version: app.getVersion() }

function broadcast(next: UpdateState): void {
  state = next
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(IPC.UPDATE_STATUS, next)
  }
}

export function updateState(): UpdateState {
  return state
}

let wired = false

function wire(): void {
  if (wired) return
  wired = true
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = CHANNEL === 'nightly'
  autoUpdater.allowDowngrade = false
  autoUpdater.channel = CHANNEL === 'nightly' ? 'nightly' : 'latest'
  console.log('UPDATE_CHANNEL', { version: app.getVersion(), channel: autoUpdater.channel })
  logUpdate('channel', { version: app.getVersion(), channel: autoUpdater.channel })
  autoUpdater.on('checking-for-update', () => broadcast({ ...state, status: 'checking', message: undefined }))
  autoUpdater.on('update-available', (info) =>
    broadcast({ channel: CHANNEL, status: 'downloading', version: info.version, percent: 0 })
  )
  autoUpdater.on('update-not-available', () =>
    broadcast({ channel: CHANNEL, status: 'none', version: app.getVersion(), message: '已经是最新版本' })
  )
  autoUpdater.on('download-progress', (progress) =>
    broadcast({ ...state, status: 'downloading', percent: Math.round(progress.percent) })
  )
  autoUpdater.on('update-downloaded', (info) =>
    broadcast({ channel: CHANNEL, status: 'ready', version: info.version, percent: 100, message: '下载完成，重启后生效' })
  )
  autoUpdater.on('error', (err) => {
    logUpdate('error', err instanceof Error ? err.message : String(err))
    broadcast({ channel: CHANNEL, status: 'error', version: app.getVersion(), message: err instanceof Error ? err.message : String(err) })
  })
}

/** 面板点「检查更新」走这里；失败也不抛——错误要显示在界面上，不是丢进控制台。 */
export async function checkForUpdates(): Promise<UpdateState> {
  if (!app.isPackaged) {
    broadcast({ channel: CHANNEL, status: 'dev', version: app.getVersion(), message: '开发模式下不检查更新' })
    return state
  }
  wire()
  try {
    await autoUpdater.checkForUpdates()
  } catch (err) {
    broadcast({
      channel: CHANNEL,
      status: 'error',
      version: app.getVersion(),
      message: err instanceof Error ? err.message : String(err)
    })
  }
  return state
}

/** 装好的新版本要用户点头才重启：正在打局时绝不自己把窗口关掉。 */
export function installUpdate(): boolean {
  if (state.status !== 'ready') return false
  setImmediate(() => autoUpdater.quitAndInstall(false, true))
  return true
}

/** 开机静默检查一次：有更新就自己下，下完在面板上挂着等用户点重启。 */
export function startUpdateCheck(): void {
  if (!app.isPackaged) return
  setTimeout(() => void checkForUpdates(), 8000)
}
