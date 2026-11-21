/**
 * 构建新鲜度的事实采集（票 113）：只读文件系统，判断在 `@shared/build-info` 里。
 *
 * 三样事实：产物 mtime（与启动日志的 BUILD_STAMP 同源，都是 `out/main/index.js`）、产物字节数、
 * `src/` 下最新的文件 mtime。打包版没有 `src/`，第三样就是 null——那时只报构建时间，不报旧不旧。
 */
import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { buildInfoOf, type BuildFacts, type BuildInfo } from '@shared/build-info'


/** 不参与「源码更新」判断的目录：构建产物、依赖、本地数据、并行工作树。 */
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', 'data', '.git', '.dev-flow', '.vite-cache'])

/** `src/` 下最新的文件 mtime；目录不存在（打包版）时为 null。 */
function newestSourceMs(sourceDir: string | null): number | null {
  if (sourceDir === null) return null
  let newest: number | null = null
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full)
        continue
      }
      try {
        const mtime = statSync(full).mtimeMs
        if (newest === null || mtime > newest) newest = mtime
      } catch {
        // 单个文件读不到不影响整体判断：跳过它，别把「读不到」说成「不旧」。
      }
    }
  }
  walk(sourceDir)
  return newest
}

/** 产物自身的事实：mtime 取不到就是 null，交给判断那边说清「读不到」。 */
function artifactFacts(): { stampMs: number | null; bytes: number | null } {
  try {
    const stat = statSync(__filename)
    return { stampMs: stat.mtimeMs, bytes: stat.size }
  } catch {
    return { stampMs: null, bytes: null }
  }
}


/**
 * 找 `src/`：`electron out/main/index.js` 这种启动方式下 `app.getAppPath()` 指的是入口脚本所在目录
 * （`<root>/out/main`），不是仓库根——所以往上试两级，谁底下真有 `src/` 就用谁；打包版一个都没有，回 null。
 */
function sourceDirOf(): string | null {
  const appPath = app.getAppPath()
  const candidates = [appPath, resolve(appPath, '..'), resolve(appPath, '../..')]
  for (const candidate of candidates) {
    const dir = resolve(candidate, 'src')
    if (existsSync(dir)) return dir
  }
  return null
}

export function readBuildInfo(): BuildInfo {
  const facts: BuildFacts = {
    ...artifactFacts(),
    // 开发时能找到 src/；打包版找不到，这里自然回 null。
    newestSourceMs: newestSourceMs(sourceDirOf())
  }
  return buildInfoOf(facts)
}
