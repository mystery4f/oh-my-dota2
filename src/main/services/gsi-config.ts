import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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

/** GSI 只推这几组：聊天工具用不到 abilities/items，开了只会把推送频率推高。 */
function cfgBody(port: number): string {
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
    '\t}',
    '}',
    ''
  ].join('\n')
}

function steamRegistryPath(): Promise<string | null> {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null)
    execFile(
      'reg',
      ['query', 'HKCU\\Software\\Valve\\Steam', '/v', 'SteamPath'],
      { windowsHide: true },
      (error, stdout) => {
        if (error) return resolve(null)
        const match = /SteamPath\s+REG_SZ\s+(.+)/i.exec(stdout)
        // 注册表里存的是正斜杠。
        resolve(match ? match[1].trim().replace(/\//g, '\\') : null)
      }
    )
  })
}

async function libraryRoots(): Promise<string[]> {
  const roots = new Set<string>()
  const steam = await steamRegistryPath()
  if (steam) roots.add(steam)
  const programFiles = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
  roots.add(join(programFiles, 'Steam'))
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

/** 在所有 Steam 库目录里找 Dota 2 的 gamestate_integration 目录。 */
async function findCfgDir(): Promise<string | null> {
  for (const root of await libraryRoots()) {
    const dir = join(root, CFG_DIR)
    if (existsSync(join(root, 'steamapps', 'common', 'dota 2 beta', 'game', 'dota'))) return dir
  }
  return null
}

export async function ensureGsiConfig(port: number): Promise<GsiConfigResult> {
  const dir = await findCfgDir()
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
    return { path: target, error: error instanceof Error ? error.message : String(error), written: false }
  }
}
