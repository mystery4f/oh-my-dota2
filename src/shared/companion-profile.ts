/**
 * #121：同局同伴画像。
 *
 * 规则只有一条：**同一局里同一个人**说过的句子，第二次出现时沿用第一次的译法，不再发一次翻译请求。
 * 为什么值得：一局里 "care mid"、"need ward" 会反复出现，让模型每次重译就可能译成两种说法
 * （「小心中路」/「中路小心」），读起来像两个人；稳定的译法才是「一个熟人一直在说话」。
 *
 * 边界也是硬规则：
 * - 换局就整份丢掉（`dropOtherMatches`），否则上一局的译法会跟到这一局；
 * - 匿名行（没有 speaker）**不进画像**：把所有人的句子混进一个桶，比不记更糟；
 * - 一局只记最近 `COMPANION_PLAYERS_MAX` 个人、每人 `COMPANION_PER_PLAYER_MAX` 句，
 *   超了丢最旧——画像只是记忆，不是账本。
 */

/** 一个玩家记多少句。 */
export const COMPANION_PER_PLAYER_MAX = 40
/** 一局记多少个玩家。 */
export const COMPANION_PLAYERS_MAX = 10

/** 画像键：大小写、空白、句尾标点都不该把同一句算成两句。 */
export function profileText(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[?!.,;:，。！？、…]+$/u, '')
}

export class CompanionProfile {
  /** matchId → player → 原句键 → 译法（Map 保持插入顺序，超限时淘汰最旧的）。 */
  private readonly matches = new Map<string, Map<string, Map<string, string>>>()

  /** 记下一句已翻好的话。匿名行（空 player）直接忽略。 */
  note(matchId: string, player: string, source: string, rendered: string): void {
    const who = player.trim()
    const key = profileText(source)
    const text = rendered.trim()
    if (who === '' || key === '' || text === '') return
    const match = this.matchOf(matchId)
    let playerMap = match.get(who)
    if (!playerMap) {
      playerMap = new Map()
      match.set(who, playerMap)
      // 超过人数上限：丢最旧的那个玩家（Map 的插入顺序就是先来后到）。
      while (match.size > COMPANION_PLAYERS_MAX) {
        const oldest = match.keys().next().value
        if (oldest === undefined || oldest === who) break
        match.delete(oldest)
      }
    }
    playerMap.set(key, text)
    while (playerMap.size > COMPANION_PER_PLAYER_MAX) {
      const oldest = playerMap.keys().next().value
      if (oldest === undefined) break
      playerMap.delete(oldest)
    }
  }

  /** 同一局同一个人说过同一句：给回上次的译法，命中即免一次翻译请求。 */
  lookup(matchId: string, player: string, source: string): string | null {
    const who = player.trim()
    if (who === '') return null
    return this.matches.get(matchId)?.get(who)?.get(profileText(source)) ?? null
  }

  /** 这一局记了几个玩家。 */
  players(matchId: string): number {
    return this.matches.get(matchId)?.size ?? 0
  }

  /** 记了几句（该玩家）。 */
  size(matchId: string, player: string): number {
    return this.matches.get(matchId)?.get(player.trim())?.size ?? 0
  }

  /** 换局：丢掉除 `keep` 之外的所有画像，返回丢了几个 match。 */
  dropOtherMatches(keep: string): number {
    let dropped = 0
    for (const matchId of [...this.matches.keys()]) {
      if (matchId === keep) continue
      this.matches.delete(matchId)
      dropped += 1
    }
    return dropped
  }

  /** 这一局结束时整份丢掉，返回丢了几个玩家。 */
  dropMatch(matchId: string): number {
    const match = this.matches.get(matchId)
    if (!match) return 0
    this.matches.delete(matchId)
    return match.size
  }

  clear(): void {
    this.matches.clear()
  }

  /** 一句话给日志：有几局、这一局几个人。 */
  line(matchId: string): string {
    const players = this.players(matchId)
    return players === 0 ? '这一局还没有可复用的译法' : `这一局记下了 ${players} 个玩家说过的句子`
  }

  private matchOf(matchId: string): Map<string, Map<string, string>> {
    let match = this.matches.get(matchId)
    if (!match) {
      match = new Map()
      this.matches.set(matchId, match)
    }
    return match
  }
}

/** 没有对局时用的键：菜单、录像、GSI 断了都归这里，不跟任何一局混。 */
export const COMPANION_NO_MATCH = 'menu'