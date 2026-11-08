import { BrowserWindow } from 'electron'
import type { IpcChannelValue } from '@shared/ipc'

/**
 * 主进程 → 所有窗口的广播（面板按钮状态、语音链回显都靠它活着）。
 * 关窗竞态：正在销毁的窗口 send 会抛，跳过它——一次广播不该炸掉整条链。
 */
export function broadcastToWindows(channel: IpcChannelValue, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed()) continue
    win.webContents.send(channel, payload)
  }
}
