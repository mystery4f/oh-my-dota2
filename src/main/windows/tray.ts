import { app, Menu, Tray, nativeImage, type MenuItemConstructorOptions } from 'electron'
import iconPath from '../../../resources/tray.png?asset'
import { getOverlayManager } from './overlay'
import { getCaptureService } from '../services/capture/capturer'

let tray: Tray | null = null
let showDashboard: () => void = () => {}
let quitApp: () => void = () => {}

function captureItem(): MenuItemConstructorOptions {
  const capture = getCaptureService()
  const status = capture.status()
  return {
    label: status.running ? '停止捕获' : '开始捕获',
    enabled: true,
    click: () => {
      if (capture.status().running) void capture.stop()
      else capture.start()
    }
  }
}

function overlayItem(): MenuItemConstructorOptions {
  const overlay = getOverlayManager()
  const status = overlay.status()
  return {
    label: '显示浮层',
    type: 'checkbox',
    checked: status.visible,
    click: () => {
      overlay.toggle()
    }
  }
}

function lockItem(): MenuItemConstructorOptions {
  const overlay = getOverlayManager()
  const status = overlay.status()
  return {
    label: '锁定浮层（可穿透 / 可拖动）',
    type: 'checkbox',
    checked: status.locked,
    enabled: status.visible,
    click: () => {
      overlay.setLocked(!overlay.status().locked)
    }
  }
}

function buildMenu(): Menu {
  return Menu.buildFromTemplate([
    { label: '打开面板', click: () => showDashboard() },
    { type: 'separator' },
    overlayItem(),
    lockItem(),
    { type: 'separator' },
    captureItem(),
    { type: 'separator' },
    { label: '退出 oh-my-dota2', click: () => quitApp() }
  ])
}

function tooltip(): string {
  const capture = getCaptureService().status()
  const overlay = getOverlayManager().status()
  const parts = [capture.running ? '捕获中' : '空闲']
  parts.push(overlay.visible ? '浮层开' : '浮层关')
  if (capture.lastError) parts.push('错误')
  return `oh-my-dota2 · ${parts.join(' · ')}`
}

/** Rebuild menu and tooltip from live state. */
export function refreshTray(): void {
  if (!tray) return
  tray.setContextMenu(buildMenu())
  tray.setToolTip(tooltip())
}

export function createTray(options: { showDashboard: () => void; quit: () => void }): Tray {
  showDashboard = options.showDashboard
  quitApp = options.quit
  if (tray) return tray
  const image = nativeImage.createFromPath(iconPath).resize({ width: 16, height: 16 })
  tray = new Tray(image)
  tray.on('click', () => showDashboard())
  refreshTray()
  getOverlayManager().onStatusChange(() => refreshTray())
  getCaptureService().onStateChange(() => refreshTray())
  return tray
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}

export function getTray(): Tray | null {
  return tray
}

export function quitLabel(): string {
  return app.getName()
}
