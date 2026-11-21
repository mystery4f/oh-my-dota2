/**
 * 构建新鲜度的事实采集（票 113，票 147 修正比较对象）：只读文件系统，判断在 `@shared/build-info` 里。
 *
 * 采的事实：产物 mtime 与字节数（与启动日志的 BUILD_STAMP 同源，都是 `out/main/index.js`），
 * 以及两组源码时间——主进程产物的输入（`src/main` + `src/preload` + `src/shared`）和渲染层
 * （`src/renderer`）。打包版没有 `src/`，两组都是 null——那时只报构建时间，不报旧不旧。
 *
 * 为什么分成两组：渲染层不进 `out/main/index.js`，开发模式下由 vite 直接服务、保存即热更新。
 * 拿它去和主进程产物比，会把「改了一行界面」报成「跑的是旧代码」，这一条踩过（#147）。
 */
import { existsSync, readdirSync, statSync, type Dirent } from 'node:fs'
import { join, resolve } from 'node:path'
import { app } from 'electron'
import { buildInfoOf, type BuildFacts, type BuildInfo } from '@shared/build-info'

/** 不参与「源码更新」判断的目录：构建产物、依赖、本地数据、并行工作树。 */
const SKIP_DIRS = new Set(['node_modules', 'out', 'dist', 'data', '.git', '.dev-flow', '.vite-cache'])

/** 主进程产物的输入目录（相对 `src/`）。preload 也打进 `out/main/index.js`。 */
const MAIN_SOURCE_DIRS = ['main', 'preload', 'shared']
/** 渲染层目录（相对 `src/`），由 vite 服务，不进主进程产物。 */
const RENDERER_SOURCE_DIRS = ['renderer']

/** 一组目录里最新的文件 mtime；全都不存在（打包版）时为 null。 */
function newestUnder(roots: string[]): number | null {
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
  for (const root of roots) {
    if (existsSync(root)) walk(root)
  }
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
  const sourceDir = sourceDirOf()
  const under = (names: string[]): number | null =>
    sourceDir === null ? null : newestUnder(names.map((name) => join(sourceDir, name)))
  const facts: BuildFacts = {
    ...artifactFacts(),
    // 开发时能找到 src/；打包版找不到，两组自然都是 null。
    newestMainMs: under(MAIN_SOURCE_DIRS),
    newestRendererMs: under(RENDERER_SOURCE_DIRS)
  }
  return buildInfoOf(facts)
}
