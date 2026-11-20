/**
 * 这一句属于哪一局：只认活着的 GSI 帧。
 *
 * 为什么单独一层：写行的那些地方（对讲计时、复盘页将来要读的东西）不该自己去问 GSI
 * 「你现在在哪一局」——那是运行时状态，问一次要绕一整个服务。GSI 每来一帧就把
 * matchid 记到这里，写行的人只读这里。
 *
 * 拿不到就给 null：菜单、看录像、GSI 断了都算不了任何一局。**绝不猜**上一个 matchid—
 * 猜错的行会把两局混成一个故事，比没有归属更糟。
 */

/**
 * 多久没有新帧就不再认这个 matchid。
 * 与 gsi.ts 的心跳判死同一个量级（90 s，三倍于 cfg 里的 30 s 心跳）：
 * 一个 3 分钟没收到帧的 matchid 不是「现在这一局」，是上一次。
 */
export const MATCH_ATTRIBUTION_TTL_MS = 90_000

let currentMatchId: string | null = null
let lastFrameAt = 0

/** 每来一帧调一次。matchid 为空表示这帧没带对局信息：不覆盖已知的归属。 */
export function noteLiveMatch(matchId: string | null | undefined, at: number = Date.now()): void {
  if (matchId === null || matchId === undefined || matchId.length === 0) return
  currentMatchId = matchId
  lastFrameAt = at
}

/**
 * 现在属于哪一局。超过 TTL 没有帧就是 null（游戏关了、GSI 断了、在菜单里）——
 * 行上写 `matchid: null` 是显式的「不知道」，不是「没有这一局」。
 */
export function liveMatchId(now: number = Date.now(), ttlMs: number = MATCH_ATTRIBUTION_TTL_MS): string | null {
  if (currentMatchId === null) return null
  if (now - lastFrameAt > ttlMs) return null
  return currentMatchId
}

/** 仅供探针/测试：把归属清回「什么都不知道」。 */
export function resetLiveMatch(): void {
  currentMatchId = null
  lastFrameAt = 0
}
