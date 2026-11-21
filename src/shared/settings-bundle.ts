/**
 * 设置包（#81）：换机器时把设置搬过去，**密钥不跟着走**。
 *
 * 三条规矩写在这个文件里，其余地方只许调用：
 * - 导出的包永远不含密钥：供应商 key、每家一枚的 key 表、可能带账号密码的代理地址，
 *   一律换成占位符，名单记进 manifest 的 `omitted`（导入端据此知道「这几项要用本机的」）。
 * - 导入先全量校验再落盘：缺文件、版本不符、条目为空都直接拒绝，一个字段都不写。
 *   半包应用会把用户的设置改成一个既不是旧值也不是新值的东西，那比重来更难查。
 * - 本机密钥绝不被包里的占位符覆盖：`keepLocalSecrets` 用当前的 key 顶回去。
 */
import type { AppSettings } from './settings-shape'

/** 包格式版本：字段含义变了才加，加完老包必须被明确拒绝（不是静默忽略）。 */
export const SETTINGS_BUNDLE_VERSION = 1
export const SETTINGS_BUNDLE_MANIFEST = 'manifest.json'
export const SETTINGS_BUNDLE_SETTINGS = 'settings.json'
export const SETTINGS_BUNDLE_TRAIN_INDEX = 'train-index.json'

/** 导出时被抹掉、导入时保持本机现值的字段（人读的名字，直接进面板提示）。 */
export const SECRET_FIELDS = ['供应商 API Key', '各供应商 key 表', '代理地址'] as const

export interface SettingsBundleManifest {
  app: string
  version: number
  createdAt: string
  /** 被抹掉的字段名：导入端据此告诉用户「这几项用的是本机的」。 */
  omitted: string[]
}

export interface SettingsBundleCheck {
  ok: boolean
  reason: string | null
}

export interface SettingsBundleExportResult {
  ok: boolean
  /** 写出的 zip 绝对路径；失败时为 null。 */
  path: string | null
  files: number
  omitted: string[]
  error: string | null
}

export interface SettingsBundleImportResult {
  ok: boolean
  /** 真正被改写的顶层字段数；0 也可能是「包拒绝」。 */
  applied: number
  kept: string[]
  error: string | null
}

export interface SettingsBundleEntry {
  name: string
  bytes: number
}

/**
 * 先校验再应用：包内必须同时有 manifest 与 settings，且 manifest 版本与本版本一致。
 * 训练索引可有可无（干净机器上本来就没有训练记录），缺了只是少一段展示。
 */
export function judgeSettingsBundle(entries: readonly SettingsBundleEntry[], version?: number): SettingsBundleCheck {
  const names = new Set(entries.map((entry) => entry.name))
  if (!names.has(SETTINGS_BUNDLE_MANIFEST)) return { ok: false, reason: '这个包里没有 manifest.json' }
  if (!names.has(SETTINGS_BUNDLE_SETTINGS)) return { ok: false, reason: '这个包里没有 settings.json' }
  const empty = entries.filter((entry) => entry.bytes <= 0).map((entry) => entry.name)
  if (empty.length > 0) return { ok: false, reason: `包内文件是空的：${empty.join('、')}` }
  if (version !== undefined && version !== SETTINGS_BUNDLE_VERSION) {
    return { ok: false, reason: `这个包是 v${version} 的，本版本只认 v${SETTINGS_BUNDLE_VERSION}` }
  }
  return { ok: true, reason: null }
}

/** 导出用的那份设置：密钥换空值，名单同时返回给 manifest。 */
export function stripSecrets(settings: AppSettings): { exported: AppSettings; omitted: string[] } {
  return {
    exported: {
      ...settings,
      provider: { ...settings.provider, apiKey: '' },
      providerKeys: {},
      proxyUrl: ''
    },
    omitted: [...SECRET_FIELDS]
  }
}

/**
 * 导入时把本机密钥顶回去：包里的 key 字段永远是空串（或者包是别人给的），
 * 用包里的空值覆盖掉本机 key 就等于把人家的机器搬成了「没配 key」。
 */
export function keepLocalSecrets(
  imported: AppSettings,
  current: AppSettings
): { settings: AppSettings; kept: string[] } {
  const kept: string[] = []
  const next: AppSettings = {
    ...imported,
    provider: { ...imported.provider, apiKey: current.provider.apiKey },
    providerKeys: { ...(current.providerKeys ?? {}) },
    proxyUrl: current.proxyUrl
  }
  if ((current.provider.apiKey ?? '') !== '') kept.push(SECRET_FIELDS[0])
  if (Object.keys(current.providerKeys ?? {}).length > 0) kept.push(SECRET_FIELDS[1])
  if ((current.proxyUrl ?? '') !== '') kept.push(SECRET_FIELDS[2])
  return { settings: next, kept }
}

/** 导出的那一行：包里几份文件、哪几项没带、落在哪。 */
export function settingsExportLine(result: SettingsBundleExportResult): string {
  if (!result.ok) return '导出失败：' + (result.error ?? '未知原因')
  const omitted = result.omitted.length > 0 ? `不带 ${result.omitted.join('、')} · ` : ''
  return `${result.files} 份文件 · ${omitted}${result.path ?? ''}`
}

/** 导入的那一行：改了几项、哪几项用的是本机的。 */
export function settingsImportLine(result: SettingsBundleImportResult): string {
  if (!result.ok) return '拒绝导入：' + (result.error ?? '包不完整')
  const kept = result.kept.length > 0 ? ' · 保留本机 ' + result.kept.join('、') : ''
  return `已导入 ${result.applied} 项${kept}`
}

/** 一行给人看的账：面板与日志共用，省得两处各写一套措辞。 */
export function settingsBundleLine(result: { files: number; omitted: string[]; kept?: string[] }): string {
  const carried = result.files > 0 ? `${result.files} 份文件` : '空包'
  const omitted = result.omitted.length > 0 ? ` · 不带 ${result.omitted.join('、')}` : ''
  const kept = result.kept !== undefined && result.kept.length > 0 ? ` · 保留本机 ${result.kept.join('、')}` : ''
  return `${carried}${omitted}${kept}`
}
