import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DEFAULT_SETTINGS, OFFLINE_VOICES, type AppSettings, type ProviderConfig } from '@shared/ipc'

function settingsFile(): string {
  return join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): AppSettings {
  try {
    const file = settingsFile()
    if (!existsSync(file)) return structuredClone(DEFAULT_SETTINGS)
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<AppSettings>
    const merged: AppSettings = {
      ...structuredClone(DEFAULT_SETTINGS),
      ...parsed,
      provider: { ...DEFAULT_SETTINGS.provider, ...(parsed.provider ?? {}) } as ProviderConfig
    }
    // 本地音色换过几轮（keqing → melo → baker）：旧值留在文件里会把面板下拉打空。
    // 这里只认还在售的 id，认不出就归位到默认，不抛错——设置文件是用户数据，不该因为改版而炸。
    // 本地音色换过几轮（keqing → melo → baker）：旧值留在文件里会把面板下拉打空。
    // 这里只认还在售的 id，认不出就归位到默认，不抛错——设置文件是用户数据，不该因为改版而炸。
    if (!OFFLINE_VOICES.some((voice) => voice.id === merged.ttsOfflineVoice)) {
      merged.ttsOfflineVoice = DEFAULT_SETTINGS.ttsOfflineVoice
    }
    // 「某某说」前缀换过类型（boolean → 'front'|'back'|'off'）：旧文件里躺着 true/false
    // 也要能读，归一化成新值，别让一次改版把朗读位置打回默认。
    const rawPrefix = (parsed as Record<string, unknown>).ttsSpeakPrefix
    if (rawPrefix === true) merged.ttsSpeakPrefix = 'front'
    else if (rawPrefix === false) merged.ttsSpeakPrefix = 'off'
    else if (merged.ttsSpeakPrefix !== 'front' && merged.ttsSpeakPrefix !== 'back' && merged.ttsSpeakPrefix !== 'off') {
      merged.ttsSpeakPrefix = DEFAULT_SETTINGS.ttsSpeakPrefix
    }
    // 说话人模板：不是字符串、或没写 {body}（内容丢了等于没配），一律回缺省。
    const tplFront = (parsed as Record<string, unknown>).ttsSpeakFrontTpl
    if (typeof tplFront !== 'string' || !tplFront.includes('{body}')) {
      merged.ttsSpeakFrontTpl = DEFAULT_SETTINGS.ttsSpeakFrontTpl
    }
    const tplBack = (parsed as Record<string, unknown>).ttsSpeakBackTpl
    if (typeof tplBack !== 'string' || !tplBack.includes('{body}')) {
      merged.ttsSpeakBackTpl = DEFAULT_SETTINGS.ttsSpeakBackTpl
    }
    return merged
  } catch (err) {
    console.error('settings: load failed, using defaults', err)
    return structuredClone(DEFAULT_SETTINGS)
  }
}

export function saveSettings(patch: Partial<AppSettings>): AppSettings {
  const current = loadSettings()
  const next: AppSettings = {
    ...current,
    ...patch,
    provider: { ...current.provider, ...(patch.provider ?? {}) } as ProviderConfig
  }
  const file = settingsFile()
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, JSON.stringify(next, null, 2), 'utf-8')
  return next
}
