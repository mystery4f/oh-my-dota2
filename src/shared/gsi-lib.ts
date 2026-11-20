/**
 * 多 Steam 库的选择缝（#78）。
 *
 * 主进程负责「找出有哪些库」（注册表 + libraryfolders.vdf + 盘符兜底），这里负责「在
 * 已知库根里挑一个用来写 GSI 配置」——纯函数，探针与预览都可以直接验。
 *
 * 规则：用户选过的根（settings.gsiLibraryRoot）优先；选的还在且装着的 Dota 就用它，
 * 不在/没装 Dota 就报 missing（不许静默回落，否则库被拔掉时面板毫无反应）；没选过就
 * 自动取第一个真装 Dota 的库。
 */

export interface SteamLibraryInfo {
  /** 库根绝对路径（`D:\SteamLibrary`）。 */
  root: string
  /** 这个库下有没有 Dota 2（`steamapps/common/dota 2 beta/game/dota` 在不在）。 */
  hasDota: boolean
}

export interface GsiRootResolve {
  /** 选定的库根；null = 没有可用库（也没法写 cfg）。 */
  root: string | null
  /** 这次用的是用户选定（false）还是自动兜底（true）。 */
  auto: boolean
  /** 用户选过但那个库现在不在/没有 Dota：报给面板，不许安静跳过。 */
  missing: boolean
}

/**
 * 在已知库根里挑写 GSI 配置的位置。
 *
 * @param roots   主进程枚举到的所有 Steam 库根（可能一个都没有）。
 * @param chosen  settings.gsiLibraryRoot：空串 = 自动；否则是用户上次选的绝对路径。
 */
export function resolveGsiRoot(roots: readonly SteamLibraryInfo[], chosen: string): GsiRootResolve {
  const usable = roots.filter((r) => r.hasDota)
  if (chosen !== '' && chosen !== null) {
    const picked = usable.find((r) => r.root === chosen)
    if (picked !== undefined) return { root: picked.root, auto: false, missing: false }
    return { root: null, auto: false, missing: true }
  }
  const first = usable[0]
  return { root: first?.root ?? null, auto: true, missing: false }
}
/** 给面板的展示名：`D:\SteamLibrary（装 Dota 的库）` / `D:\SteamLibrary（没装 Dota）`。 */
export function libraryLabel(info: SteamLibraryInfo): string {
  return `${info.root}${info.hasDota ? '' : '（没装 Dota）'}`
}

/** IPC 供给面板的一整份：「都有哪些库、用户选的是哪个（空自动）、这次会用它写 cfg 吗」。 */
export interface GsiLibrariesView {
  /** 枚举到的所有 Steam 库根（注册表 + vdf + 兜底扫描，可能没装 Dota）。 */
  roots: SteamLibraryInfo[]
  /** settings.gsiLibraryRoot：空串 = 自动。 */
  chosen: string
  /** 对着当前 settings 与可用库算出来的落点（含 missing 标记）。 */
  resolve: GsiRootResolve
}

/** gsiSetLibrary 的结果；path 为 null 时 error 一定非空。 */
export interface GsiLibrarySetResult {
  ok: boolean
  error?: string
  path?: string | null
}