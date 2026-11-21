import type { VoiceChainLast, VoiceChainSummary } from '@shared/ipc'
import { liveMatchId } from '../gsi-match'

/**
 * 最后一条对讲（#167）：**只留一条、只在内存、不落盘、不新开文件**。
 *
 * matchid 在记录这一刻问 `liveMatchId()`：不在对局里（菜单、GSI 断了、超过 90 s）就照实存 null。
 * 绝不拿上一帧的局号回填——面板会据此把别人的局当成这一局，那是本票最贵的错。
 */
let last: VoiceChainLast | null = null

export function noteChainLast(summary: VoiceChainSummary, matchid: string | null = liveMatchId()): void {
  last = { matchid, summary }
}

export function chainLast(): VoiceChainLast | null {
  return last
}

/** 探针用：清空，好断言「刚启动时是 null」。 */
export function resetChainLastForProbe(): void {
  last = null
}