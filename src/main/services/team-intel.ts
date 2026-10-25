/**
 * 队伍情报：把 GSI 的 `allplayers` 整理成一张「这局谁是谁」的表。
 *
 * 为什么值得单独一层：聊天事件只给 slot，前缀里已经拼了英雄和敌我，但那是一行的信息；
 * 面板上需要的是**整局视角**——我方几个人、对面是谁、谁还没说过话。这些判断要能离线
 * 复算（探针直接喂数据），所以规则放在这里，不埋在 gsi.ts 的循环里。
 */

/** 站位：我方 / 敌方 / 还不知道（队伍信息缺失时不能瞎猜）。 */
export type RosterSide = 'mine' | 'enemy' | 'unknown'

export interface RosterEntry {
  /** 归一化后的槽位（"0"–"9"，天辉 0–4、夜魇 5–9），用于去重和排序。 */
  slot: number
  name: string
  /** 英雄短名（`nevermore` 这种），没有就是空串。 */
  hero: string
  side: RosterSide
}

export interface RosterInput {
  /** 原始槽位：天辉 0–4，夜魇 128–132。 */
  slot: number
  name?: string
  hero?: string
  /** 统一小写的 `radiant` / `dire`；缺失表示这一帧没带队伍信息。 */
  team?: string
}

/**
 * 槽位有两套写法：`allplayers` 的 key 是 "0"–"9"（天辉 0–4、夜魇 5–9），
 * 而 `player.player_slot` 里夜魇带 128 偏移（128–132）。统一到前者，128 → 5，
 * 这样同一个人从两条路进来能合到一行。
 */
export function normalizeSlot(slot: number): number {
  return slot >= 128 ? slot - 123 : slot
}

function sideOf(team: string, myTeam: string): RosterSide {
  if (team.length === 0 || myTeam.length === 0) return 'unknown'
  return team === myTeam ? 'mine' : 'enemy'
}

/**
 * 组装名单。同一槽位可能从 `allplayers` 和 `player` 两处进来（自己那份不在 allplayers 里），
 * 所以按归一槽位合并：名字/英雄谁有就用谁的，队伍认第一次出现的非空值。
 */
export function buildRoster(
  players: RosterInput[],
  mySlot: number | undefined,
  myTeamRaw: string
): RosterEntry[] {
  const myTeam = myTeamRaw.trim().toLowerCase()
  const merged = new Map<number, RosterEntry>()
  for (const player of players) {
    if (!Number.isFinite(player.slot)) continue
    const slot = normalizeSlot(player.slot)
    const team = typeof player.team === 'string' ? player.team.trim().toLowerCase() : ''
    const self = mySlot !== undefined && normalizeSlot(mySlot) === slot
    const side = self && myTeam.length > 0 ? 'mine' : sideOf(team, myTeam)
    const current = merged.get(slot)
    const name = typeof player.name === 'string' ? player.name.trim() : ''
    const hero = typeof player.hero === 'string' ? player.hero.trim().replace(/^npc_dota_hero_/, '') : ''
    if (current) {
      if (current.name.length === 0 && name.length > 0) current.name = name
      if (current.hero.length === 0 && hero.length > 0) current.hero = hero
      if (current.side === 'unknown' && side !== 'unknown') current.side = side
      continue
    }
    merged.set(slot, { slot, name, hero, side })
  }
  // 我方在前、同侧按槽位升序：面板上一眼就能数清「我们几个」。
  const order: Record<RosterSide, number> = { mine: 0, enemy: 1, unknown: 2 }
  return [...merged.values()].sort((a, b) => order[a.side] - order[b.side] || a.slot - b.slot)
}

/** 一句话概括，给面板状态行用：`我方 5 · 敌方 5 · 英雄 8/10`。 */
export function rosterLine(roster: RosterEntry[]): string {
  if (roster.length === 0) return ''
  const mine = roster.filter((item) => item.side === 'mine').length
  const enemy = roster.filter((item) => item.side === 'enemy').length
  const heroes = roster.filter((item) => item.hero.length > 0).length
  return `我方 ${mine} · 敌方 ${enemy} · 英雄 ${heroes}/${roster.length}`
}
