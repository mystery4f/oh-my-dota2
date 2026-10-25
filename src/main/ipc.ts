import { BrowserWindow, app, clipboard, ipcMain } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  IPC,
  type AppSettings,
  type ReplySendResult,
  type ProviderConfig,
  type InPlaceResult,
  type OverlayGeometry,
  type ReplyResult,
  type ReplyTone,
  type TranslateDirection
} from '@shared/ipc'
import { loadSettings, saveSettings } from './services/settings'
import { translationInsights } from './services/session/translate-cache'
import { checkForUpdates, installUpdate } from './services/updater'
import { testProvider, translateText } from './services/providers'
import { sessionStatus, translateReply, translateTry } from './services/session/durable-translator'
import { getCaptureService } from './services/capture/capturer'
import { buildSayTeamCommand, getConsoleSender } from './services/input/console-send'
import { getInPlaceSender } from './services/input/chat-inplace'
import { getChatSender, normalizeChatLine } from './services/input/chat-send'
import { getWhisperAdapter } from './services/voice/whisper'
import { getTtsAdapter } from './services/voice/tts'
import { ensureOfflineModel, offlineStatus } from './services/voice/offline'
import { getOverlayManager } from './windows/overlay'
import { gsiStatus } from './services/gsi'

export async function sendReply(text: string): Promise<ReplySendResult> {
  const settings = loadSettings()
  const draft = text.trim()
  if (!draft) return { ok: false, draft: '', translated: null, command: null, error: '内容为空' }

  const overlay = getOverlayManager()
  let translated: string | null = null
  try {
    translated = await translateReply(settings.provider, draft, settings.replyTone)
  } catch (err) {
    return {
      ok: false,
      draft,
      translated: null,
      command: null,
      error: err instanceof Error ? err.message : String(err)
    }
  }
  if (!translated) {
    return { ok: false, draft, translated: null, command: null, error: '翻译结果为空' }
  }

  const line = normalizeChatLine(translated)
  if (!line) {
    return { ok: false, draft, translated, command: null, error: '译文没有可发送的英文字符' }
  }
  const command = settings.sendMode === 'console' ? buildSayTeamCommand(translated) : line
  overlay.closeReply(false)
  const sent =
    settings.sendMode === 'console'
      ? await getConsoleSender().send(command, settings.consoleKey)
      : await getChatSender().send(line)
  if (!sent.ok) {
    overlay.openReply()
    return { ok: false, draft, translated, command, error: sent.error ?? '发送失败' }
  }
  return { ok: true, draft, translated, command }
}

/**
 * 读取游戏聊天框里已经打好但未发送的中文，翻译成英文后粘贴回同一个输入框并回车发送。
 * 全程不切换前台窗口，也不经过控制台。
 */
export async function translateInPlace(): Promise<InPlaceResult> {
  const settings = loadSettings()
  const sender = getInPlaceSender()
  const grabbed = await sender.grab()
  if (!grabbed.ok || !grabbed.text) {
    return {
      ok: false,
      draft: null,
      translated: null,
      grabMs: grabbed.ms,
      error: grabbed.error ?? '没有读到聊天框内容'
    }
  }
  const draft = grabbed.text
  const translateStartedAt = Date.now()
  let translated: string | null = null
  try {
    translated = await translateReply(settings.provider, draft, settings.replyTone)
  } catch (err) {
    return {
      ok: false,
      draft,
      translated: null,
      grabMs: grabbed.ms,
      translateMs: Date.now() - translateStartedAt,
      error: err instanceof Error ? err.message : String(err)
    }
  }
  const translateMs = Date.now() - translateStartedAt
  if (!translated) {
    return { ok: false, draft, translated: null, grabMs: grabbed.ms, translateMs, error: '翻译结果为空' }
  }
  const line = normalizeChatLine(translated)
  if (!line) {
    return { ok: false, draft, translated, grabMs: grabbed.ms, translateMs, error: '译文没有可发送的英文字符' }
  }
  const sent = await sender.replace(line)
  if (!sent.ok) {
    return {
      ok: false,
      draft,
      translated,
      grabMs: grabbed.ms,
      translateMs,
      sendMs: sent.ms,
      error: sent.error ?? '写回聊天框并发送失败'
    }
  }
  return { ok: true, draft, translated: line, grabMs: grabbed.ms, translateMs, sendMs: sent.ms }
}

export function registerIpc(): void {
  ipcMain.handle(IPC.SETTINGS_GET, () => loadSettings())
  ipcMain.handle(IPC.CACHE_STATS, () => translationInsights())
  ipcMain.handle(IPC.APP_VERSION, () => app.getVersion())
  ipcMain.handle(IPC.UPDATE_CHECK, () => checkForUpdates())
  ipcMain.handle(IPC.UPDATE_INSTALL, () => installUpdate())
  ipcMain.handle(IPC.REPLY_INPLACE, () => translateInPlace())
  ipcMain.handle(IPC.SETTINGS_SET, (_e, patch: Partial<AppSettings>) => saveSettings(patch))
  ipcMain.handle(IPC.PROVIDER_TEST, (_e, provider: ProviderConfig) => testProvider(provider))
  ipcMain.handle(IPC.PROVIDER_TRANSLATE, (_e, text: string, direction?: TranslateDirection) =>
    translateTry(loadSettings().provider, text, direction ?? 'en-zh').catch(() =>
      // 会话层失败时退回直连，保证「翻译试用」永远能给出结果或明确报错。
      translateText(loadSettings().provider, text, direction ?? 'en-zh')
    )
  )
  ipcMain.handle(IPC.REPLY_TRANSLATE, async (_e, text: string, tone?: ReplyTone): Promise<ReplyResult> => {
    const trimmed = String(text ?? '').trim()
    if (!trimmed) return { ok: false, translated: null, copied: false, error: '内容为空' }
    const settings = loadSettings()
    try {
      const translated = await translateReply(settings.provider, trimmed, tone ?? settings.replyTone)
      clipboard.writeText(translated)
      return { ok: true, translated, copied: true }
    } catch (err) {
      return {
        ok: false,
        translated: null,
        copied: false,
        error: err instanceof Error ? err.message : String(err)
      }
    }
  })
  ipcMain.handle(IPC.REPLY_SEND, (_e, text: string) => sendReply(text))
  ipcMain.handle(IPC.CAPTURE_START, () => getCaptureService().start())
  ipcMain.handle(IPC.CAPTURE_STOP, () => getCaptureService().stop())
  ipcMain.handle(IPC.CAPTURE_STATUS, () => ({ ...getCaptureService().status(), gsi: gsiStatus() }))
  ipcMain.handle(IPC.SESSION_STATUS, () => sessionStatus())
  ipcMain.handle(IPC.OVERLAY_TOGGLE, () => getOverlayManager().toggle())
  ipcMain.handle(IPC.OVERLAY_TEXT, (_e, mode) => getOverlayManager().setText(mode))
  ipcMain.handle(IPC.OVERLAY_LOCK, (_e, locked: boolean) => getOverlayManager().setLocked(locked))
  ipcMain.handle(IPC.OVERLAY_OPACITY, (_e, value: number) => getOverlayManager().setOpacity(value))
  ipcMain.handle(IPC.OVERLAY_GEOMETRY, (_e, patch: Partial<OverlayGeometry>) =>
    getOverlayManager().applyGeometry(patch ?? {})
  )
  ipcMain.handle(IPC.OVERLAY_GEOMETRY_RESET, () => getOverlayManager().resetGeometry())
  ipcMain.handle(IPC.OVERLAY_VOICE, (_event, read: boolean) => getOverlayManager().setVoice(Boolean(read)))
  ipcMain.handle(IPC.OVERLAY_COLLAPSE, () => getOverlayManager().toggleCollapse())
  ipcMain.handle(IPC.OVERLAY_KEEPALIVE, () => getOverlayManager().keepAlive())
  ipcMain.handle(IPC.OVERLAY_NUDGE, (_event, dx: number, dy: number) => getOverlayManager().nudge(dx, dy))
  ipcMain.handle(IPC.OVERLAY_SNAP, () => getOverlayManager().snap())
  ipcMain.handle(IPC.OVERLAY_REPLY_OPEN, () => getOverlayManager().openReply())
  ipcMain.handle(IPC.OVERLAY_REPLY_STATE, () => getOverlayManager().status())
  ipcMain.handle(IPC.VOICE_WHISPER_PROBE, (_e, binPath: string) =>
    getWhisperAdapter().probe(String(binPath ?? ''))
  )
  ipcMain.handle(IPC.VOICE_WHISPER_SETUP, () =>
    getWhisperAdapter().ensureAssets((phase, pct) => {
      for (const win of BrowserWindow.getAllWindows()) {
        win.webContents.send(IPC.VOICE_WHISPER_PROGRESS, { phase, pct })
      }
    })
  )
  ipcMain.handle(IPC.VOICE_TRANSCRIBE, async (_e, wavBase64: string, language?: string) => {
    const base64 = String(wavBase64 ?? '')
    if (!base64) return { ok: false, text: '', error: '音频为空' }
    const dir = join(app.getPath('userData'), 'voice')
    mkdirSync(dir, { recursive: true })
    const wavPath = join(dir, 'utterance.wav')
    writeFileSync(wavPath, Buffer.from(base64, 'base64'))
    return getWhisperAdapter().transcribe(wavPath, language ?? 'auto')
  })
  ipcMain.handle(IPC.TTS_OFFLINE_STATE, () => offlineStatus())
  ipcMain.handle(IPC.TTS_OFFLINE_DOWNLOAD, () => ensureOfflineModel())
  ipcMain.handle(IPC.VOICE_TTS_PREVIEW, (_e, text: string) =>
    getTtsAdapter().preview(String(text ?? ''))
  )
  ipcMain.handle(IPC.OVERLAY_REPLY_CLOSE, (_e, submitted?: boolean) =>
    getOverlayManager().closeReply(Boolean(submitted))
  )
}
