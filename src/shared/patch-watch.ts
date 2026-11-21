/**
 * 补丁巡检（#131）：Valve 改了 GSI / 加了英雄 / 换了事件类型时，先把「我们不知道的东西」记下来。
 *
 * 三件事都只做本地比对，不联网、不猜：
 * - 字段：这一帧带来的路径里，哪些我们从没读过（unread）；我们声明要读的路径里，哪些一次都没到（missing）；
 * - 英雄：帧里出现的英雄 id，按词表能不能翻（词表用的展示名和 GSI 的 id 有几处对不上，见 HERO_ALIASES）；
 * - 事件：`events[].event_type` 出现了我们没有分支处理的类型（Valve 加新事件就是这样先露出水面的）。
 *
 * 为什么先把「没读过的字段」当信号而不是噪声：GSI 的 payload 由 cfg 里的数据块决定，
 * 我们自己的 cfg 只开 provider/map/player/events，所以多出来的路径只可能是 Valve 改了结构。
 * 采样窗口内的 missing 只说明「这段时间没推」，写日志时带样本帧数，不写成结论。
 *
 * 「健康安装什么都不写」由调用方保证：已经记过的缺口（seen）不再进日志，第二局同样的缺口一句都不落盘。
 */

/**
 * 我们真的读的路径，写法跟 collectFramePaths 一致：对象块写裸名，数组/map 块写 `k[]`，叶字段写 `k.f`。
 * 新加读取的地方要补一个痕迹，否则它会以 unread 的形式报出来。
 */
export const GSI_READ_PATHS: readonly string[] = [
  'provider',
  'provider.name',
  'provider.appid',
  'map',
  'map.name',
  'map.game_state',
  'map.matchid',
  'map.game_time',
  'map.win_team',
  'player',
  'player.name',
  'player.team_name',
  'player.player_slot',
  'player.team_slot',
  'player.steamid',
  'events',
  'events[]',
  'events[].event_type',
  'events[].player_id',
  'events[].channel_type',
  'events[].message',
  'events[].game_time',
  'allplayers',
  'allplayers[]',
  'allplayers[].name',
  'allplayers[].team',
  'allplayers[].hero',
  'allplayers[].hero_id',
  'hero',
  'hero.name',
  'hero.id',
  'draft',
  'roshan',
  'roshan.state',
  'roshan.death_time',
  'roshan.respawn_time'
]

/**
 * 只有某些阶段才推的路径：它们一次没到说明不了「Valve 删了字段」，只说明这一刻没有这个块
 * （选人阶段之前没有 draft，肉山活着时没有 roshan，对局没结束没有 win_team）。
 * 这些不参与 missing 判定，否则每一局开头都会报一串假警报，真警报反而被淹没。
 */
export const GSI_OPTIONAL_PATHS: readonly string[] = [
  'map.win_team',
  'draft',
  'roshan',
  'roshan.state',
  'roshan.death_time',
  'roshan.respawn_time'
]

/** 一个采样窗口至少要这么多帧才判断 missing：几帧里没推某个块是常态（肉山活着时没有 roshan 块）。 */
export const PATCH_WATCH_MIN_FRAMES = 20

/**
 * 词表按展示名写英雄，GSI 按 `npc_dota_hero_<id>` 给：这几处 id 和展示名不同形，
 * 不列出来就会把「词表里明明有的英雄」报成缺口。
 */
export const HERO_ALIASES: Readonly<Record<string, string>> = {
  nevermore: 'Shadow Fiend',
  obsidian_destroyer: 'Outworld Destroyer',
  treant: 'Treant Protector',
  doom_bringer: 'Doom',
  windrunner: 'Windranger'
}

/** 我们有分支处理的事件类型。 */
export const HANDLED_EVENT_TYPES: readonly string[] = ['chat_message']

/** 面板与主进程共用的巡检视图：一行话 + 计数，别把原始缺口表推给渲染进程。 */
export interface PatchWatchView {
  /** 采样窗口里已经过了多少帧；0 表示这一局还没开始或者还没收到帧。 */
  frames: number
  /** 还没记过的缺口条数。 */
  gaps: number
  /** 一句话（面板只显示这一行）；没有缺口时是 null。 */
  line: string | null
  /** 最近一次判断的时间。 */
  at: string | null
}

export type PatchGapKind = 'field-unread' | 'field-missing' | 'hero' | 'event-type'

export interface PatchGap {
  kind: PatchGapKind
  /** 缺口本身的名字：字段路径、英雄 id、事件类型。日志与面板都直呼其名。 */
  name: string
  /** 一句人话，面板上显示的是 patchWatchLine，不是这一条。 */
  detail: string
}

export interface PatchWatchSample {
  /** 采样窗口里出现过的所有路径（多帧的并集）。 */
  paths: readonly string[]
  /** 采样窗口里出现过的英雄 id（已去掉 `npc_dota_hero_` 前缀）。 */
  heroes: readonly string[]
  /** 采样窗口里出现过的事件类型。 */
  eventTypes: readonly string[]
  /** 采了多少帧；不到 PATCH_WATCH_MIN_FRAMES 时只报 unread，不报 missing。 */
  frames: number
}

/** 英雄 id / 展示名归一化：`Anti-Mage`、`antimage`、`anti_mage` 是同一个。 */
export function heroKey(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/^npc_dota_hero_/, '')
    .replace(/[^a-z0-9]/g, '')
}

/** 词表里这个英雄能不能翻：id 归一化后命中，或者先过 HERO_ALIASES 再命中。 */
export function glossaryHasHero(heroId: string, glossaryNames: readonly string[]): boolean {
  const keys = new Set(glossaryNames.map(heroKey))
  const direct = heroKey(heroId)
  if (keys.has(direct)) return true
  // 别名表用 GSI 的原始 id 做键（带下划线），归一化之后查不到，所以两种写法都试。
  const raw = heroId.trim().toLowerCase().replace(/^npc_dota_hero_/, '')
  const alias = HERO_ALIASES[raw] ?? HERO_ALIASES[direct]
  return alias !== undefined && keys.has(heroKey(alias))
}

/** 一帧的路径集合：对象下探一层，数组记成 `k[]` 并合并各元素的字段，`allplayers` 这种 map 也当数组看。 */
export function collectFramePaths(payload: unknown): string[] {
  const out = new Set<string>()
  if (payload === null || typeof payload !== 'object') return []
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    out.add(key)
    if (Array.isArray(value)) {
      out.add(`${key}[]`)
      for (const item of value) addFields(out, `${key}[]`, item)
    } else if (value !== null && typeof value === 'object' && key === 'allplayers') {
      out.add(`${key}[]`)
      for (const item of Object.values(value as Record<string, unknown>)) addFields(out, `${key}[]`, item)
    } else if (value !== null && typeof value === 'object') {
      for (const field of Object.keys(value as Record<string, unknown>)) out.add(`${key}.${field}`)
    }
  }
  return [...out]
}

function addFields(into: Set<string>, prefix: string, item: unknown): void {
  if (item === null || typeof item !== 'object') return
  for (const field of Object.keys(item as Record<string, unknown>)) into.add(`${prefix}.${field}`)
}

/**
 * 三件事各判一次，缺口按「字段 → 英雄 → 事件」固定顺序出，方便日志前后对照。
 *
 * `missing` 只在采样够帧时才报：几帧里没推的块说明不了问题，而一个装好却一次都没出现的字段
 * 恰恰说明「我们以为在读的东西，游戏已经不发了」。
 */
export function judgePatchWatch(sample: PatchWatchSample, glossaryNames: readonly string[]): PatchGap[] {
  const gaps: PatchGap[] = []
  const present = new Set(sample.paths)
  const declared = new Set(GSI_READ_PATHS)

  for (const path of sample.paths) {
    if (declared.has(path)) continue
    gaps.push({ kind: 'field-unread', name: path, detail: `游戏发来了 ${path}，我们从没读过` })
  }
  if (sample.frames >= PATCH_WATCH_MIN_FRAMES) {
    const optional = new Set(GSI_OPTIONAL_PATHS)
    for (const path of GSI_READ_PATHS) {
      if (optional.has(path) || present.has(path)) continue
      gaps.push({
        kind: 'field-missing',
        name: path,
        detail: `${sample.frames} 帧里 ${path} 一次都没到，可能改名或被移除`
      })
    }
  }
  for (const hero of sample.heroes) {
    if (glossaryHasHero(hero, glossaryNames)) continue
    gaps.push({ kind: 'hero', name: hero, detail: `词表里没有 ${hero}，这一局的英雄名翻不出来` })
  }
  for (const type of sample.eventTypes) {
    if (HANDLED_EVENT_TYPES.includes(type)) continue
    gaps.push({ kind: 'event-type', name: type, detail: `事件 ${type} 没有分支处理` })
  }
  return gaps
}

/** 缺口的稳定键：同一件事第二次出现不该再写一行日志。 */
export function patchGapKey(gap: PatchGap): string {
  return `${gap.kind}:${gap.name}`
}

/** 只留没记过的缺口。 */
export function unseenGaps(gaps: readonly PatchGap[], seen: Iterable<string>): PatchGap[] {
  const known = new Set(seen)
  return gaps.filter((gap) => !known.has(patchGapKey(gap)))
}

/** 面板与日志共用的一句话：最多点三个名字，剩下的说数量。 */
export function patchWatchLine(gaps: readonly PatchGap[]): string {
  if (gaps.length === 0) return '和游戏对得上'
  const head = gaps.slice(0, 3).map((gap) => gap.name)
  const tail = gaps.length > head.length ? ` 等 ${gaps.length} 项` : ''
  return `游戏里出现了我们还不认识的：${head.join('、')}${tail}`
}

export interface PatchWatchRecord {
  /** appendCappedJsonl 要求 Record：显式给一条索引签名，别让调用处去断言。 */
  [key: string]: unknown
  at: string
  frames: number
  gaps: PatchGap[]
}

export function patchWatchRecord(gaps: readonly PatchGap[], frames: number, at: string): PatchWatchRecord {
  return { at, frames, gaps: [...gaps] }
}