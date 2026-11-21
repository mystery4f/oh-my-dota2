/**
 * 设置包的读写（#81）：一盘 zip，设置 + 训练产物索引，**不带密钥**。
 *
 * 为什么放在主进程：读写的都是数据目录里的文件与 SQLite，渲染层只该拿结果与一句话。
 * 为什么先校验后落盘：见 `@shared/settings-bundle` 的注释——半包应用比拒绝难查得多。
 *
 * 所有路径与「怎么落盘」都可注入：探针用临时目录 + 假 apply，绝不碰用户真实设置。
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app } from 'electron'
import type { AppSettings } from '@shared/settings-shape'
import {
  type SettingsBundleExportResult,
  type SettingsBundleImportResult,
  SETTINGS_BUNDLE_MANIFEST,
  SETTINGS_BUNDLE_SETTINGS,
  SETTINGS_BUNDLE_TRAIN_INDEX,
  SETTINGS_BUNDLE_VERSION,
  judgeSettingsBundle,
  keepLocalSecrets,
  stripSecrets,
  type SettingsBundleManifest
} from '@shared/settings-bundle'
import { loadSettings, saveSettings } from './settings'
import { listTrainRuns } from './train/run-store'
import { buildZip, readZip } from './zip'

type BundleExportResult = SettingsBundleExportResult
type BundleImportResult = SettingsBundleImportResult

/** 训练产物索引：只记「跑过什么、产物在哪」，不含权重与数据集本身。 */
export function trainIndexRows(): Record<string, unknown>[] {
  try {
    return listTrainRuns().map((run) => ({
      id: run.id,
      kind: run.kind,
      experiment: run.experiment,
      status: run.status,
      startedAt: run.startedAt,
      endedAt: run.endedAt,
      applied: run.applied,
      metrics: run.metrics ?? null
    }))
  } catch {
    // 干净机器上还没有 runs.db：索引就是空数组，不该让导出失败。
    return []
  }
}

export function exportSettingsBundle(options: {
  dir?: string
  settings?: AppSettings
  at?: Date
  trainIndex?: () => Record<string, unknown>[]
} = {}): BundleExportResult {
  const dir = options.dir ?? join(app.getPath('userData'), 'export')
  const at = options.at ?? new Date()
  try {
    const settings = options.settings ?? loadSettings()
    const { exported, omitted } = stripSecrets(settings)
    const manifest: SettingsBundleManifest = {
      app: app.getName(),
      version: SETTINGS_BUNDLE_VERSION,
      createdAt: at.toISOString(),
      omitted
    }
    const entries = [
      { name: SETTINGS_BUNDLE_MANIFEST, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
      { name: SETTINGS_BUNDLE_SETTINGS, data: Buffer.from(JSON.stringify(exported, null, 2), 'utf8') },
      {
        name: SETTINGS_BUNDLE_TRAIN_INDEX,
        data: Buffer.from(JSON.stringify((options.trainIndex ?? trainIndexRows)(), null, 2), 'utf8')
      }
    ]
    mkdirSync(dir, { recursive: true })
    const stamp = at.toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-')
    const path = join(dir, `settings-${stamp}.zip`)
    writeFileSync(path, buildZip(entries, at))
    console.log('SETTINGS_BUNDLE_EXPORT ' + JSON.stringify({ path, files: entries.length, omitted }))
    return { ok: true, path, files: entries.length, omitted, error: null }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.log('SETTINGS_BUNDLE_EXPORT_FAIL ' + JSON.stringify({ error: message }))
    return { ok: false, path: null, files: 0, omitted: [], error: message }
  }
}

/**
 * 导入：zip → 全量校验 → 合并（保留本机密钥）→ 一次落盘。
 * `apply` 默认真写设置；探针注入假函数，验证「拒绝时一次都不调用」。
 */
export function importSettingsBundle(
  zipPath: string,
  options: { apply?: (patch: Partial<AppSettings>) => void; current?: AppSettings } = {}
): BundleImportResult {
  const reject = (error: string): BundleImportResult => {
    console.log('SETTINGS_BUNDLE_IMPORT_REJECT ' + JSON.stringify({ file: basename(zipPath), error }))
    return { ok: false, applied: 0, kept: [], error }
  }
  let files: Map<string, Uint8Array> | null
  try {
    files = readZip(readFileSync(zipPath))
  } catch (err) {
    return reject(`读不了这个文件：${err instanceof Error ? err.message : String(err)}`)
  }
  if (files === null) return reject('不是有效的 zip（文件可能没下完）')
  const check = judgeSettingsBundle(
    [...files.entries()].map(([name, data]) => ({ name, bytes: data.byteLength }))
  )
  if (!check.ok) return reject(check.reason ?? '包不完整')
  const decoder = new TextDecoder('utf-8')
  let manifest: SettingsBundleManifest
  let imported: AppSettings
  try {
    manifest = JSON.parse(decoder.decode(files.get(SETTINGS_BUNDLE_MANIFEST))) as SettingsBundleManifest
    imported = JSON.parse(decoder.decode(files.get(SETTINGS_BUNDLE_SETTINGS))) as AppSettings
  } catch (err) {
    return reject(`包里的内容是坏 JSON：${err instanceof Error ? err.message : String(err)}`)
  }
  const versioned = judgeSettingsBundle(
    [...files.entries()].map(([name, data]) => ({ name, bytes: data.byteLength })),
    manifest.version
  )
  if (!versioned.ok) return reject(versioned.reason ?? '版本不符')
  const current = options.current ?? loadSettings()
  const { settings, kept } = keepLocalSecrets(imported, current)
  const changed = (Object.keys(settings) as (keyof AppSettings)[]).filter(
    (key) => JSON.stringify(settings[key]) !== JSON.stringify(current[key])
  )
  try {
    ;(options.apply ?? ((patch: Partial<AppSettings>) => void saveSettings(patch)))(settings)
  } catch (err) {
    return reject(`写入失败：${err instanceof Error ? err.message : String(err)}`)
  }
  console.log(
    'SETTINGS_BUNDLE_IMPORT ' +
      JSON.stringify({ file: basename(zipPath), changed: changed.length, kept, omitted: manifest.omitted ?? [] })
  )
  return { ok: true, applied: changed.length, kept, error: null }
}
