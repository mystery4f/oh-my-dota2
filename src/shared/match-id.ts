/**
 * 「这个 matchid 算不算一局真对局」（issue #162）。
 *
 * 规则只有一条，放在这里是因为有两处要问同一件事：时间线（记不记这一局）与 GSI 抓包总结
 * （这一抓是不是真局）。拆成两份就会漂移——训练场被当成比赛、菜单被当成一局，
 * 都是这么来的。**判据是帧里看得见的事实，不猜**：主菜单/训练场/人机都给 `"0"`，
 * 真对局是十几位数字。
 */
export function isRealMatchId(matchId: string | null | undefined): matchId is string {
  if (typeof matchId !== 'string') return false
  if (matchId.length <= 3) return false
  if (matchId === '0') return false
  return /^\d+$/.test(matchId)
}
