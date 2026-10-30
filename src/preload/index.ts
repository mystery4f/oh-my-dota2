import { contextBridge, ipcRenderer } from 'electron'
import {
  IPC,
  type CaptureEntry,
  type OverlayStatus,
  type OverlayTextMode,
  type SovitsRefEntry,
  type SpeakPayload,
  type StreamRect,
  type UpdateState,
  type VoiceAssetProgress,
  type WindowApi
} from '@shared/ipc'

const api: WindowApi = {
  getSettings: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
  setSettings: (patch) => ipcRenderer.invoke(IPC.SETTINGS_SET, patch),
  testProvider: (provider) => ipcRenderer.invoke(IPC.PROVIDER_TEST, provider),
  translate: (text, direction) => ipcRenderer.invoke(IPC.PROVIDER_TRANSLATE, text, direction),
  translateReply: (text, tone) => ipcRenderer.invoke(IPC.REPLY_TRANSLATE, text, tone),
  whisperProbe: (binPath) => ipcRenderer.invoke(IPC.VOICE_WHISPER_PROBE, binPath),
  whisperSetup: () => ipcRenderer.invoke(IPC.VOICE_WHISPER_SETUP),
  transcribeAudio: (wavBase64, language) => ipcRenderer.invoke(IPC.VOICE_TRANSCRIBE, wavBase64, language),
  onVoiceRecordToggle: (callback) => {
    const listener = (): void => callback()
    ipcRenderer.on(IPC.VOICE_RECORD_TOGGLE, listener)
    return () => ipcRenderer.removeListener(IPC.VOICE_RECORD_TOGGLE, listener)
  },
  onWhisperProgress: (callback) => {
    const listener = (_e: Electron.IpcRendererEvent, progress: VoiceAssetProgress): void => callback(progress)
    ipcRenderer.on(IPC.VOICE_WHISPER_PROGRESS, listener)
    return () => ipcRenderer.removeListener(IPC.VOICE_WHISPER_PROGRESS, listener)
  },
  ttsPreview: (text) => ipcRenderer.invoke(IPC.VOICE_TTS_PREVIEW, text),
  captureStart: () => ipcRenderer.invoke(IPC.CAPTURE_START),
  captureStop: () => ipcRenderer.invoke(IPC.CAPTURE_STOP),
  captureStatus: () => ipcRenderer.invoke(IPC.CAPTURE_STATUS),
  translatorStatus: () => ipcRenderer.invoke(IPC.SESSION_STATUS),
  cacheStats: () => ipcRenderer.invoke(IPC.CACHE_STATS),
  appVersion: () => ipcRenderer.invoke(IPC.APP_VERSION),
  updateCheck: () => ipcRenderer.invoke(IPC.UPDATE_CHECK),
  updateInstall: () => ipcRenderer.invoke(IPC.UPDATE_INSTALL),
  onUpdateStatus: (callback) => {
    const listener = (_e: Electron.IpcRendererEvent, state: UpdateState): void => callback(state)
    ipcRenderer.on(IPC.UPDATE_STATUS, listener)
    return () => ipcRenderer.removeListener(IPC.UPDATE_STATUS, listener)
  },
  sendReply: (text) => ipcRenderer.invoke(IPC.REPLY_SEND, text),
  translateInPlace: () => ipcRenderer.invoke(IPC.REPLY_INPLACE),
  onCaptureReplace: (callback) => {
    const listener = (_e: Electron.IpcRendererEvent, entries: CaptureEntry[]): void => callback(entries)
    ipcRenderer.on(IPC.CAPTURE_REPLACE, listener)
    return () => ipcRenderer.removeListener(IPC.CAPTURE_REPLACE, listener)
  },
  onCaptureEntries: (callback) => {
    const listener = (_e: Electron.IpcRendererEvent, entries: CaptureEntry[]): void => callback(entries)
    ipcRenderer.on(IPC.CAPTURE_ENTRIES, listener)
    return () => ipcRenderer.removeListener(IPC.CAPTURE_ENTRIES, listener)
  },
  onCaptureUpdate: (callback) => {
    const listener = (_e: Electron.IpcRendererEvent, entries: CaptureEntry[]): void => callback(entries)
    ipcRenderer.on(IPC.CAPTURE_UPDATE, listener)
    return () => ipcRenderer.removeListener(IPC.CAPTURE_UPDATE, listener)
  },
  screenStream: {
    onInit: (callback) => {
      const listener = (_e: Electron.IpcRendererEvent, payload: { sourceId: string }): void => callback(payload)
      ipcRenderer.on(IPC.STREAM_INIT, listener)
      return () => ipcRenderer.removeListener(IPC.STREAM_INIT, listener)
    },
    onGrab: (callback) => {
      const listener = (
        _e: Electron.IpcRendererEvent,
        payload: { requestId: number; rect: StreamRect }
      ): void => callback(payload)
      ipcRenderer.on(IPC.STREAM_GRAB, listener)
      return () => ipcRenderer.removeListener(IPC.STREAM_GRAB, listener)
    },
    reportHello: () => ipcRenderer.send(IPC.STREAM_HELLO),
    reportReady: () => ipcRenderer.send(IPC.STREAM_READY),
    reportFrame: (requestId, pngBase64, error) =>
      ipcRenderer.send(IPC.STREAM_FRAME, { requestId, pngBase64, error })
  },
  overlayToggle: () => ipcRenderer.invoke(IPC.OVERLAY_TOGGLE),
  overlaySetText: (mode: OverlayTextMode) => ipcRenderer.invoke(IPC.OVERLAY_TEXT, mode),
  overlayOpenReply: () => ipcRenderer.invoke(IPC.OVERLAY_REPLY_OPEN),
  overlayCloseReply: (submitted) => ipcRenderer.invoke(IPC.OVERLAY_REPLY_CLOSE, submitted),
  overlayReplyState: () => ipcRenderer.invoke(IPC.OVERLAY_REPLY_STATE),
  overlaySetLocked: (locked) => ipcRenderer.invoke(IPC.OVERLAY_LOCK, locked),
  overlaySetOpacity: (value) => ipcRenderer.invoke(IPC.OVERLAY_OPACITY, value),
  overlaySetGeometry: (patch) => ipcRenderer.invoke(IPC.OVERLAY_GEOMETRY, patch),
  overlayResetGeometry: () => ipcRenderer.invoke(IPC.OVERLAY_GEOMETRY_RESET),
  overlaySetVoice: (read: boolean) => ipcRenderer.invoke(IPC.OVERLAY_VOICE, read),
  overlayToggleCollapse: () => ipcRenderer.invoke(IPC.OVERLAY_COLLAPSE),
  overlayKeepAlive: () => ipcRenderer.invoke(IPC.OVERLAY_KEEPALIVE),
  overlayNudge: (dx: number, dy: number) => ipcRenderer.invoke(IPC.OVERLAY_NUDGE, dx, dy),
  overlaySnap: () => ipcRenderer.invoke(IPC.OVERLAY_SNAP),
  onOverlayReply: (callback) => {
    const listener = (_e: Electron.IpcRendererEvent, open: boolean): void => callback(open)
    ipcRenderer.on(IPC.OVERLAY_REPLY, listener)
    return () => ipcRenderer.removeListener(IPC.OVERLAY_REPLY, listener)
  },
  onOverlayState: (callback) => {
    const listener = (_e: Electron.IpcRendererEvent, state: OverlayStatus): void => callback(state)
    ipcRenderer.on(IPC.OVERLAY_STATE, listener)
    return () => ipcRenderer.removeListener(IPC.OVERLAY_STATE, listener)
  },
  ttsOfflineState: () => ipcRenderer.invoke(IPC.TTS_OFFLINE_STATE),
  ttsOfflineDownload: () => ipcRenderer.invoke(IPC.TTS_OFFLINE_DOWNLOAD),
  sovitsStatus: () => ipcRenderer.invoke(IPC.TTS_SOVITS_STATUS),
  sovitsInstall: () => ipcRenderer.invoke(IPC.TTS_SOVITS_INSTALL),
  sovitsRefs: () => ipcRenderer.invoke(IPC.TTS_SOVITS_REFS),
  sovitsVoicepacks: () => ipcRenderer.invoke(IPC.TTS_SOVITS_VOICEPACKS),
  sovitsVoicepackInstall: (id: string) => ipcRenderer.invoke(IPC.TTS_SOVITS_VOICEPACK_INSTALL, id),
  sovitsSelectRef: (entry: SovitsRefEntry) => ipcRenderer.invoke(IPC.TTS_SOVITS_SELECT_REF, entry),
  sovitsSeed: () => ipcRenderer.invoke(IPC.TTS_SOVITS_SEED),
  onVoiceSpeak: (callback) => {
    const listener = (_e: Electron.IpcRendererEvent, payload: SpeakPayload): void => callback(payload)
    ipcRenderer.on(IPC.VOICE_SPEAK, listener)
    return () => ipcRenderer.removeListener(IPC.VOICE_SPEAK, listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
