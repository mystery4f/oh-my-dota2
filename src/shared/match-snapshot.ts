/**
 * 副屏面板的数据契约（#124b）。
 *
 * 铁律两条，写在文件头免得后来者破例：
 *  1. **只有一份 GSI reader**。这里的输入永远是 `src/main/services/gsi.ts` 已经解析过的那一帧
 *     原始 payload，副屏窗口读快照、浮层读快照、这里也读快照——谁都不另开一个 HTTP 监听。
 *  2. **新增字段一律可缺**。`cfgBody` 早就把 hero/items/abilities 等块全开了（2026-10-25 那次
 *     "一次开全"），但用户可能还在跑旧 cfg、或某帧里某块就是没到。缺了填 null，
 *     绝不进 `gsi-stall.ts` 的断流告警——「断流」判据只有一条：帧不来了。
 *
 * `items` 取物品名与 id（稳定），`abilities` 只取**学到的等级**：冷却时间每帧都在走，
 * 把它写进 5 秒一次的摘要只会让摘要变成噪声（pm 明确点过这条）。
 */

/** 一件装备。`name` 与 `id` 都可能缺，缺了填 null。 */
export interface SnapshotItem {
  name: string | null
  id: number | null
}

/** 一个技能：只留名字与等级，冷却/可用不要。 */
export interface SnapshotAbility {
  name: string
  level: number
}

export interface SnapshotHero {
  name: string | null
  level: number | null
  alive: boolean | null
  /** 死亡时还剩几秒复活；活着是 null。 */
  respawnIn: number | null
}

export interface SnapshotScore {
  kills: number | null
  deaths: number | null
  assists: number | null
}

/** 一帧的可读摘要。所有字段都可能为 null——「没有」不等于「零」。 */
export interface MatchSnapshot {
  at: number
  matchid: string | null
  gameState: string | null
  /** 比赛时间（秒），负数是选人阶段倒计时。 */
  clockTime: number | null
  /** 昼夜：true = 白天。 */
  daytime: boolean | null
  hero: SnapshotHero
  /** 自己身上的钱；拿不到是 null（不是 0）。 */
  gold: number | null
  score: SnapshotScore
  /** 学到的技能等级，按等级降序；空数组 = 这一帧没带 abilities 块。 */
  abilities: SnapshotAbility[]
  items: SnapshotItem[]
}

/** 探针与面板都用它读空值，避免各处各写一份 `?? null`。 */
export function emptySnapshot(at = 0): MatchSnapshot {
  return {
    at,
    matchid: null,
    gameState: null,
    clockTime: null,
    daytime: null,
    hero: { name: null, level: null, alive: null, respawnIn: null },
    gold: null,
    score: { kills: null, deaths: null, assists: null },
    abilities: [],
    items: []
  }
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

/** 只认识我们真会用到的那几个键；多出来的（wearables/buildings…）直接不看。 */
interface SnapshotInput {
  map?: { matchid?: unknown; game_state?: unknown; clock_time?: unknown; daytime?: unknown }
  hero?: {
    name?: unknown
    level?: unknown
    alive?: unknown
    respawn_seconds?: unknown
    gold?: unknown
    kills?: unknown
    deaths?: unknown
    assists?: unknown
  }
  items?: Record<string, { name?: unknown; id?: unknown } | undefined>
  abilities?: Record<string, { name?: unknown; level?: unknown } | undefined>
}

export function snapshotOf(payload: SnapshotInput | null | undefined, at = Date.now()): MatchSnapshot {
  const out = emptySnapshot(at)
  if (!payload) return out
  const map = payload.map
  out.matchid = strOrNull(map?.matchid)
  out.gameState = strOrNull(map?.game_state)
  out.clockTime = numOrNull(map?.clock_time)
  const daytime = map?.daytime
  out.daytime = typeof daytime === 'boolean' ? daytime : null

  const hero = payload.hero
  if (hero) {
    out.hero = {
      name: strOrNull(hero.name),
      level: numOrNull(hero.level),
      alive: typeof hero.alive === 'boolean' ? hero.alive : null,
      respawnIn: typeof hero.alive === 'boolean' && !hero.alive ? numOrNull(hero.respawn_seconds) : null
    }
    out.gold = numOrNull(hero.gold)
    out.score = {
      kills: numOrNull(hero.kills),
      deaths: numOrNull(hero.deaths),
      assists: numOrNull(hero.assists)
    }
  }

  const abilities = payload.abilities
  if (abilities) {
    out.abilities = Object.values(abilities)
      .map((slot) => (slot ? { name: strOrNull(slot.name) ?? '', level: numOrNull(slot.level) ?? 0 } : null))
      .filter((slot): slot is SnapshotAbility => slot !== null && slot.name !== '' && slot.level > 0)
      .sort((a, b) => b.level - a.level || a.name.localeCompare(b.name))
  }

  const items = payload.items
  if (items) {
    out.items = Object.keys(items)
      .sort()
      .map((slot) => {
        const item = items[slot]
        return { name: strOrNull(item?.name), id: numOrNull(item?.id) }
      })
      // 空格子（GSI 里 name 为 "empty" 或全空）不算装备。
      .filter((item) => item.name !== null && item.name !== 'empty')
  }

  return out
}

/** 一行给人看：`3 秒 白天 · 影魔 Lv7 · 1200 金 · 3/1/5 · 技能 3 · 装备 4`。 */
export function snapshotLine(snapshot: MatchSnapshot): string {
  const parts: string[] = []
  if (snapshot.clockTime !== null) {
    const total = Math.abs(Math.floor(snapshot.clockTime))
    const mm = Math.floor(total / 60)
    const ss = String(total % 60).padStart(2, '0')
    parts.push(`${snapshot.clockTime < 0 ? '-' : ''}${mm}:${ss}`)
  }
  if (snapshot.daytime !== null) parts.push(snapshot.daytime ? '白天' : '黑夜')
  if (snapshot.hero.name !== null) {
    parts.push(snapshot.hero.level === null ? snapshot.hero.name : `${snapshot.hero.name} Lv${snapshot.hero.level}`)
  }
  if (snapshot.gold !== null) parts.push(`${snapshot.gold} 金`)
  const { kills, deaths, assists } = snapshot.score
  if (kills !== null && deaths !== null && assists !== null) parts.push(`${kills}/${deaths}/${assists}`)
  if (snapshot.abilities.length > 0) parts.push(`技能 ${snapshot.abilities.length}`)
  if (snapshot.items.length > 0) parts.push(`装备 ${snapshot.items.length}`)
  return parts.length > 0 ? parts.join(' · ') : '这一帧没有可读的字段'
}
