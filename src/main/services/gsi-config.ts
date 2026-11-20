import { execFile } from 'node:child_process'
import { errorMessage } from '@shared/errors'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parseDotaVideoMode, type DotaDisplayMode } from '@shared/dota-video'
import { loadSettings, saveSettings } from './settings'
import { resolveGsiRoot, type GsiLibrariesView, type GsiLibrarySetResult } from '@shared/gsi-lib'

/**
 * 往 Dota 2 的 `cfg/gamestate_integration/` 里放一份 GSI 配置。
 *
 * 每个工具各放自己的 cfg，Dota 会同时推给所有配置——罗技 G HUB 那份
 * `gamestate_integration_logitech.cfg`（`http://127.0.0.1:3002`）就是现成的例子，
 * 所以这里换个文件名、换个端口，互不干扰。
 */
export interface GsiConfigResult {
  /** 写入/已存在的 cfg 路径，找不到 Dota 目录时为 null。 */
  path: string | null
  error: string | null
  /** 内容有变化才重写，false = 之前已经写好了。 */
  written: boolean
}

const CFG_FILE = 'gamestate_integration_ohmydota2.cfg'
const CFG_DIR = join('steamapps', 'common', 'dota 2 beta', 'game', 'dota', 'cfg', 'gamestate_integration')

/**
 * data 块全量开启：draft/buildings 等键一直没请求过，全开才能排除「配置漏请求」；Dota 会忽略不认识的键，无害。
 * 但 `allplayers` 请求了也白搭——真对局实测（match 9061130332 3499 帧、9061444883 156 帧）
 * 一帧都没推，Dota 2 GSI 在对局中只给本机 `player`/`hero`，全员数据只在观战/录像时到。
 * 所以别人的英雄名拿不到是数据上限，不是配置问题，也不是代码 bug。
 */
/** 导出给 --gsi-probe 断言形状：曾经九行写成字面 `\t`，cfg 看着齐全、实际一个块都没请求。 */
export function cfgBody(port: number): string {
  return [
    '"Oh-my-dota2 Game State Integration"',
    '{',
    `\t"uri"\t"http://127.0.0.1:${port}"`,
    '\t"timeout"\t"5.0"',
    '\t"buffer"\t"0.1"',
    '\t"throttle"\t"0.1"',
    // 30 s 一次心跳：长时间没变化时也能确认游戏还活着（本地看门狗等 90 s）。
    '\t"heartbeat"\t"30.0"',
    '\t"data"',
    '\t{',
    '\t\t"provider"\t"1"',
    '\t\t"map"\t\t"1"',
    '\t\t"player"\t"1"',
    // 2026-11 起开 events：对局内聊天会作为 chat_message 事件推进 payload.events[]，
    // 正文能不能整条搬到 GSI 上就靠它验证（见 docs/PLAN.md 候选方案）。
    '\t\t"events"\t"1"',
    // 聊天事件只带说话人的 slot，不带昵称；开 allplayers 才能把 slot 翻成名字，
    // 浮层上的「谁说的」才和 OCR 那条路长得一样。
    '\t\t"allplayers"\t"1"',
    // 英雄同理：allplayers 里查不到自己那一份，只有开 hero 才拿得到自己的英雄名。
    '\t\t"hero"\t\t"1"',
    // 以下这些块全都用真 tab：写成字面 `\t` 的话 KeyValues 只看到一串无意义 token，
    // 等于没请求（2026-10-25 盘上 cfg 就长这样，九行全废）。
    // 清单对齐 Dota2GSI `GenerateGSIConfigFile` 官方模板再补 previously/added/allplayers，
    // 一次开全：Dota 忽略不认识的键，以后要用 neutralitems/league 时不必再改 cfg、再求用户重启游戏。
    '\t\t"auth"\t\t\t"1"',
    '\t\t"abilities"\t"1"',
    '\t\t"items"\t\t"1"',
    '\t\t"league"\t\t"1"',
    '\t\t"draft"\t\t"1"',
    '\t\t"wearables"\t"1"',
    '\t\t"buildings"\t"1"',
    '\t\t"minimap"\t"1"',
    '\t\t"roshan"\t\t"1"',
    '\t\t"couriers"\t"1"',
    '\t\t"neutralitems"\t"1"',
    '\t\t"previously"\t"1"',
    '\t\t"added"\t\t"1"',
    '\t}',
    '}',
    ''
  ].join('\n')
}

/**
 * Steam 可能登记的注册表位置：先用户级（Steam 自己写的），再机器级（绿色安装版的 InstallPath）。
 * 只问一个键是不够的——Steam 装在 D 盘时 HKCU 里可能根本没有 `SteamPath`。
 */
const STEAM_REG_KEYS: readonly (readonly [string, string])[] = [
  ['HKCU\\Software\\Valve\\Steam', 'SteamPath'],
  ['HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
  ['HKLM\\SOFTWARE\\Valve\\Steam', 'InstallPath']
]

/** `reg query` 的原始输出（不猜编码：中文路径按 utf8 解出来是乱码，见 `decodeRegOutput`）。 */
function regQuery(key: string, name: string): Promise<Buffer | null> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null)
    execFile(
      'reg',
      ['query', key, '/v', name],
      { windowsHide: true, encoding: 'buffer' },
      (error, stdout) => resolve(error ? null : (stdout as unknown as Buffer))
    )
  })
}

/**
 * 同一次查询给出两种解码：reg.exe 按控制台代码页输出，中文 Windows 上是 GBK，
 * 而我们第一反应是 utf8。两个都试、再用 `existsSync` 验真——
 * 解错的路径会直接落到「不存在」，不会拿一串乱码去拼目录。
 */
function decodeRegOutput(raw: Buffer): string[] {
  const out: string[] = []
  for (const label of ['utf-8', 'gbk']) {
    try {
      out.push(new TextDecoder(label).decode(raw))
    } catch {
      // 这个运行时没带该解码器（小体积 ICU 构建）：跳过，反正还有 existsSync 兜底。
    }
  }
  return out
}

/** 注册表里所有能验真的 Steam 根，去重后按发现顺序返回。 */
async function registrySteamPaths(): Promise<string[]> {
  const found = new Set<string>()
  for (const [key, name] of STEAM_REG_KEYS) {
    const raw = await regQuery(key, name)
    if (raw === null) continue
    const pattern = new RegExp(`${name}\\s+REG_SZ\\s+(.+)`, 'i')
    for (const text of decodeRegOutput(raw)) {
      const match = pattern.exec(text)
      if (match === null) continue
      // 注册表里存的是正斜杠（Steam 自己写的那种）。
      const path = match[1].trim().replace(/\//g, '\\').replace(/\\+$/, '')
      if (path !== '' && existsSync(path)) found.add(path)
    }
  }
  return [...found]
}

/** Dota 2 的 game/dota 目录在不在：这是「这个根是不是真装着游戏」的唯一判据。 */
function hasDota(root: string): boolean {
  return existsSync(join(root, 'steamapps', 'common', 'dota 2 beta', 'game', 'dota'))
}

/**
 * 兜底扫描：注册表读不到或解不出来时（Steam 装在移动硬盘、绿色版、中文路径），
 * 扫盘符找 `steamapps`。只在第一条路失败后才调用——正常启动不该为兜底付 78 次 stat。
 */
function scannedSteamRoots(): string[] {
  if (process.platform !== 'win32') return []
  const found: string[] = []
  for (let code = 65; code <= 90; code += 1) {
    const drive = `${String.fromCharCode(code)}:\\`
    for (const candidate of [
      join(drive, 'Steam'),
      join(drive, 'SteamLibrary'),
      join(drive, 'Program Files (x86)', 'Steam'),
      join(drive, 'Program Files', 'Steam')
    ])
      if (existsSync(join(candidate, 'steamapps'))) found.push(candidate)
  }
  return found
}

async function libraryRoots(extra: readonly string[] = []): Promise<string[]> {
  const roots = new Set<string>()
  for (const steam of await registrySteamPaths()) roots.add(steam)
  const programFiles = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  roots.add(join(programFiles, 'Steam'))
  // 兜底扫描给进来的根：只在注册表那条路失败时才有内容。
  for (const root of extra) roots.add(root)
  // 候选只在开头取一次：vdf 里读出来的库根可能还有自己的 vdf，展开一轮就够（不做递归）。
  const candidates = [...roots]
  for (const root of candidates) {
    const vdf = join(root, 'steamapps', 'libraryfolders.vdf')
    if (!existsSync(vdf)) continue
    try {
      const text = await readFile(vdf, 'utf8')
      for (const match of text.matchAll(/"path"\s+"([^"]+)"/g))
        roots.add(match[1].replace(/\\\\/g, '\\'))
    } catch {
      // 读不动就算了，继续用已知的根目录试。
    }
  }
  return [...roots]
}

/**
 * 在所有 Steam 库目录里找 Dota 2 的 gamestate_integration 目录。
 *
 * 两条路：注册表给的那些根，找不到再扫盘符（Steam 在移动硬盘、绿色版、注册表被清过）。
 * 扫描只在失败后发生——正常启动不该为一个兜底路径付 26×4 次 stat。
 */
/** 枚举到的所有 Steam 库根（注册表 + vdf 展开，可能包含没装 Dota 的库）。 */
/** 枚举到的所有 Steam 库根（注册表 + vdf 展开，可能包含没装 Dota 的库）。 */
export async function listLibraries(): Promise<string[]> {
  const known = await libraryRoots()
  // 注册表给的路子里已经有人装了 Dota 就不再扫盘符：正常启动不该为兜底付 26×4 次 stat。
  if (known.some(hasDota)) return [...new Set(known)]
  const widened = await libraryRoots(scannedSteamRoots())
  return [...new Set([...known, ...widened])]
}

/** 面板要的一整份：哪些库、选的是哪个、这次会落到哪（含「选的库不在了」）。 */
export async function gsiLibrariesView(): Promise<GsiLibrariesView> {
  const roots = (await listLibraries()).map((root) => ({ root, hasDota: hasDota(root) }))
  const chosen = loadSettings().gsiLibraryRoot
  return { roots, chosen, resolve: resolveGsiRoot(roots, chosen) }
}

/**
 * 记住用户选的库并立刻写一遍 cfg。
 *
 * 传空串 = 回到自动。选的库必须在枚举结果里且真的装 Dota——否则保存一个写不进 cfg 的路径，
 * 而用户以为已经生效，那是最难查的一类「我选了啊」（#78）。
 */
export async function setGsiLibrary(root: string, port: number): Promise<GsiLibrarySetResult> {
  const wanted = root.trim()
  if (wanted !== '') {
    const view = await gsiLibrariesView()
    const info = view.roots.find((item) => item.root === wanted)
    if (info === undefined) return { ok: false, error: `这个目录不在 Steam 库里：${wanted}` }
    if (!info.hasDota) return { ok: false, error: `这个库里没有 Dota 2（缺 steamapps/common/dota 2 beta）：${wanted}` }
  }
  saveSettings({ gsiLibraryRoot: wanted })
  const ensured = await ensureGsiConfig(port)
  return { ok: ensured.error === null, error: ensured.error ?? undefined, path: ensured.path }
}

interface CfgDirPick {
  dir: string | null
  /** 用户选过、但现在找不到（或没装 Dota）的那个库根；非空时调用方必须报出来。 */
  missing: string | null
}

/**
 * 决定写进哪个库的 gamestate_integration。
 *
 * 选了库就只认那个库：它被拔掉/改盘符时报「路径缺失」，**绝不**悄悄改写到别的库——
 * 那样用户在「为什么我选了 D 盘却写到 C 盘」上永远查不到线索（#78）。
 */
async function pickCfgDir(): Promise<CfgDirPick> {
  const view = await gsiLibrariesView()
  if (view.resolve.missing) return { dir: null, missing: view.chosen }
  return { dir: view.resolve.root === null ? null : join(view.resolve.root, CFG_DIR), missing: null }
}
/**
 * 读 Dota 2 的显示模式（独占全屏 / 全屏窗口 / 窗口）。
 *
 * 浮层「看不见」最常不是置顶写错了，而是游戏跑在独占全屏——独占交换链上什么都画不上去。
 * 这份设置只有游戏自己写：`userdata/<账号>/570/local/cfg/video.txt`，多个账号时取最新改动的那份
 * （用户切账号或改设置时会重写，旧文件的时间戳会停在原地）。
 * 纯解析在 `@shared/dota-video`，这里只负责找文件。
 */
export async function dotaDisplayMode(): Promise<DotaDisplayMode | null> {
  let newest: { at: number; text: string } | null = null
  for (const root of await libraryRoots()) {
    const userdata = join(root, 'userdata')
    if (!existsSync(userdata)) continue
    let accounts: string[] = []
    try {
      accounts = await readdir(userdata)
    } catch {
      continue
    }
    for (const account of accounts) {
      const file = join(userdata, account, '570', 'local', 'cfg', 'video.txt')
      try {
        const info = await stat(file)
        if (newest !== null && info.mtimeMs <= newest.at) continue
        newest = { at: info.mtimeMs, text: await readFile(file, 'utf8') }
      } catch {
        // 这个账号没玩过 / 文件读不动：换下一个。
      }
    }
  }
  return newest === null ? null : parseDotaVideoMode(newest.text)
}


export async function ensureGsiConfig(port: number): Promise<GsiConfigResult> {
  const pick = await pickCfgDir()
  if (pick.missing !== null) {
    // 选了库就必须写进那个库：报缺失让人重选，而不是悄悄换一个库（#78）。
    return {
      path: null,
      error: `选的 Steam 库找不到了：${pick.missing}（盘符变了或盘没插？在面板里重选，或清掉选择让应用自动找）`,
      written: false
    }
  }
  const dir = pick.dir
  if (!dir) {
    return { path: null, error: '没找到 Dota 2 安装目录（可以手动把 cfg 放进 cfg/gamestate_integration/）', written: false }
  }
  const target = join(dir, CFG_FILE)
  const body = cfgBody(port)
  try {
    const existing = existsSync(target) ? await readFile(target, 'utf8') : null
    if (existing === body) return { path: target, error: null, written: false }
    await mkdir(dir, { recursive: true })
    await writeFile(target, body, 'utf8')
    return { path: target, error: null, written: true }
  } catch (error) {
    return { path: target, error: errorMessage(error), written: false }
  }
}
