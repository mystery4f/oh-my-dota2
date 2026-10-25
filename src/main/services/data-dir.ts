import { app } from 'electron'
import { accessSync, constants, copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'

/**
 * 便携数据目录。
 *
 * 安装版：安装目录的**同级** `<安装目录名>-data`（`G:\oh-my-dota2` → `G:\oh-my-dota2-data`）。
 * 放同级而不是放里面，是因为 NSIS 卸载用 `RMDir /r "$INSTDIR"` 把安装目录整个删掉，
 * 数据在里面就只能靠「卸载时搬走」这种绕路保命；放同级则卸载器根本碰不到它。
 * 开发版（npm run dev / 探针）：项目根的 `data/`，不再往 C 盘的 AppData 里塞东西。
 * 只有两种情况下退回到系统 userData：目录建不出来，或者建出来不可写（装到了 Program Files）。
 */
export function portableDataDir(): string | null {
  const portable = process.env.PORTABLE_EXECUTABLE_DIR
  const installRoot = portable ? portable : app.isPackaged ? dirname(process.execPath) : process.cwd()
  const dir =
    portable !== undefined || app.isPackaged
      ? join(dirname(installRoot), basename(installRoot) + '-data')
      : join(installRoot, 'data')
  try {
    mkdirSync(dir, { recursive: true })
    accessSync(dir, constants.W_OK)
    return dir
  } catch {
    return null
  }
}

/** 老版本里已经被删掉的键：搬过来只会让新版本读到一个不存在的字段。 */
const RETIRED_KEYS = ['chatRegion', 'captureMode', 'chatSource', 'ocrEngine', 'captureIntervalMs']

/**
 * 搬老设置与账本。
 *
 * 目标目录已经有 settings.json 时不能整个跳过——实测踩过：老实例（还没升级数据目录的版本）
 * 在后台又写了几次设置，新目录里那份就成了旧的。所以这里按字段合并：
 * 目标里没有的键从老文件补进来，目标里已有一律不覆盖，已废弃的键两边都清掉。
 */
function migrateLegacy(previous: string, target: string): void {
  if (previous === target) return
  const targetFile = join(target, 'settings.json')
  const sourceFile = join(previous, 'settings.json')
  try {
    if (existsSync(sourceFile)) {
      const source = JSON.parse(readFileSync(sourceFile, 'utf8')) as Record<string, unknown>
      const current = existsSync(targetFile)
        ? (JSON.parse(readFileSync(targetFile, 'utf8')) as Record<string, unknown>)
        : {}
      const added: string[] = []
      for (const [key, value] of Object.entries(source)) {
        if (RETIRED_KEYS.includes(key)) continue
        if (!(key in current)) {
          current[key] = value
          added.push(key)
        }
      }
      for (const key of RETIRED_KEYS) delete current[key]
      writeFileSync(targetFile, JSON.stringify(current, null, 2) + String.fromCharCode(10))
      if (added.length > 0) console.log('DATA_DIR_MERGED', { from: previous, fields: added })
    }
    for (const name of ['translate-cache.sqlite', 'translate-cache.sqlite-wal', 'translate-cache.sqlite-shm']) {
      const from = join(previous, name)
      const to = join(target, name)
      if (existsSync(from) && !existsSync(to)) copyFileSync(from, to)
    }
  } catch (err) {
    console.log('DATA_DIR_MIGRATE_FAILED', err instanceof Error ? err.message : String(err))
  }
}

/**
 * 必须在 app ready 之前调用：settings、会话库、日志、词库全都挂在 userData 下面。
 * Electron 会把 userData 的其它子路径（logs/sessions 等）跟着一起改，所以只改这一个。
 */
export function applyPortableUserData(): string {
  const dir = portableDataDir()
  if (dir === null) {
    const fallback = app.getPath('userData')
    console.log('DATA_DIR_FALLBACK', { reason: 'exe 目录不可写', userData: fallback })
    return fallback
  }
  // 三个来源都可能留下数据：C 盘 AppData（上一版）、安装目录里的 data（更早一版）、
  // 以及新位置自己。按顺序合并，后来的只补空缺，不会盖掉已经搬进来的新值。
  for (const previous of [app.getPath('userData'), join(dirname(dir), basename(dir).replace(/-data$/, ''), 'data')]) {
    migrateLegacy(previous, dir)
  }
  app.setPath('userData', dir)
  app.setPath('sessionData', join(dir, 'chromium'))
  console.log('DATA_DIR', dir)
  return dir
}
