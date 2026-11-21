/**
 * 一键诊断包（#111）：把 `logs/` 里那几份证据打成一个 zip，带 manifest、版本与构建戳。
 *
 * 三件事只在这里做：读文件（IO）、脱敏（纯缝 `@shared/log-bundle`）、打包（`./zip`）。
 * 面板点一下就得到「导出到哪、含几个文件、缺哪几个」；缺的那几份不是失败，它们会出现在
 * manifest 的 missing 里——静默跳过会让排查的人以为「日志里没有」，其实是「这个安装还没产生」。
 *
 * 默认脱敏：昵称与设备 id 换成占位。要原样导出得显式传 `mask: false`，那是把别人的对局
 * 发言直接发出去，不是默认该发生的事。
 */
import { existsSync, statSync } from 'node:fs'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import {
  buildLogBundleManifest,
  LOG_BUNDLE_FILES,
  maskLogText,
  type LogBundleFile,
  type LogBundleManifest,
  type LogBundleResult
} from '@shared/log-bundle'
import { buildZip, type ZipEntry } from './zip'

export interface LogBundleOptions {
  /** 证据目录，默认 `<userData>/logs`；探针传临时目录，绝不往真实数据里写。 */
  logsDir?: string
  version?: string
  buildStamp?: string | null
  mask?: boolean
  /** 用来给包命名与写 manifest 的时间；探针传定值，两次导出才会字节一致。 */
  now?: Date
}

/** 与启动日志的 BUILD_STAMP 同源：主进程包（`out/main/index.js`）的 mtime；拿不到就 null。 */
function buildStampOf(): string | null {
  try {
    return statSync(__filename).mtime.toISOString()
  } catch {
    return null
  }
}

/** 包名：`20261121-041500` 这种可排序的本地时间戳，一秒一个不覆盖。 */
function stampOf(at: Date): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0')
  return `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`
}

export async function exportLogBundle(options: LogBundleOptions = {}): Promise<LogBundleResult> {
  const logsDir = options.logsDir ?? join(app.getPath('userData'), 'logs')
  const version = options.version ?? app.getVersion()
  const buildStamp = options.buildStamp === undefined ? buildStampOf() : options.buildStamp
  const mask = options.mask ?? true
  const at = options.now ?? new Date()

  try {
    const entries: ZipEntry[] = []
    const files: LogBundleFile[] = []
    const missing: string[] = []
    // 一个包一张编号表：同一个人在每个文件里都是同一个「玩家N」（#139）
    const aliases = new Map<string, string>()
    for (const wanted of LOG_BUNDLE_FILES) {
      const full = join(logsDir, wanted.name)
      if (!existsSync(full)) {
        if (!('optional' in wanted && wanted.optional === true)) missing.push(wanted.name)
        continue
      }
      const raw = await readFile(full)
      const masked = maskLogText(raw.toString('utf8'), wanted.mask && mask, aliases)
      const data = Buffer.from(masked.text, 'utf8')
      entries.push({ name: wanted.name, data })
      files.push({ name: wanted.name, bytes: raw.length, masked: masked.masked })
    }

    const manifest: LogBundleManifest = buildLogBundleManifest({
      version,
      buildStamp,
      createdAt: at.toISOString(),
      platform: `${process.platform}-${process.arch}`,
      files,
      missing
    })
    entries.push({ name: 'manifest.json', data: Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8') })

    const outDir = join(logsDir, 'export')
    await mkdir(outDir, { recursive: true })
    const outPath = join(outDir, `log-bundle-${stampOf(at)}.zip`)
    const zip = buildZip(entries, at)
    await writeFile(outPath, zip)
    const written = await stat(outPath)
    console.log(
      'LOG_BUNDLE_EXPORT',
      JSON.stringify({ path: outPath, files: files.length, missing: missing.length, bytes: written.size })
    )
    return { ok: true, path: outPath, bytes: written.size, files: files.length, missing, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    console.log('LOG_BUNDLE_EXPORT_FAIL', JSON.stringify({ error: message }))
    return { ok: false, path: null, bytes: 0, files: 0, missing: [], error: message }
  }
}
