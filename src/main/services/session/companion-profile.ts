/**
 * #121：同局同伴画像的进程内单例。
 *
 * 纯规则在 `@shared/companion-profile`；这里只解决两件事：用哪一局的键、换局时何时丢。
 * 对局键取自 `liveMatchId()`（90 秒内收到过帧才算在打，否则算菜单）——猜出来的 matchid
 * 会让上一局的译法跟到下一局，那比不复用更糟。
 */
import { COMPANION_NO_MATCH, CompanionProfile } from '@shared/companion-profile'
import { liveMatchId } from '../gsi-match'

const profile = new CompanionProfile()

/** 当前该用哪一局的画像：在打对局就用它的 matchid，否则统一落到 `menu`。 */
export function companionMatchKey(): string {
  return liveMatchId() ?? COMPANION_NO_MATCH
}

/** 同一局同一个人说过同一句：命中就给回上次的译法（免一次翻译请求）。 */
export function companionLookup(player: string | undefined, source: string): string | null {
  if (!player) return null
  return profile.lookup(companionMatchKey(), player, source)
}

/** 记下一句已翻好的话；顺手把别的局丢掉（换局即清，不留上一局的影子）。 */
export function companionNote(player: string | undefined, source: string, rendered: string): void {
  if (!player) return
  const key = companionMatchKey()
  const dropped = profile.dropOtherMatches(key)
  if (dropped > 0) console.log('COMPANION_DROP_MATCHES', JSON.stringify({ dropped, keep: key }))
  profile.note(key, player, source, rendered)
}

/** 对局结束（`endMatchSession`）：整份丢掉这一局。 */
export function companionDropMatch(): number {
  return profile.dropMatch(companionMatchKey())
}

/** 面板/日志要的那一句；不写死玩家数，让运行时决定。 */
export function companionLine(): string {
  return profile.line(companionMatchKey())
}

/** 探针用：清空全部画像，别把上一条断言的结果带进来。 */
export function resetCompanionProfileForProbe(): void {
  profile.clear()
}