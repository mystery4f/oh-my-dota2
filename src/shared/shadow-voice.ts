/**
 * 影子模式（#80）：第一局先不出声，只把「本该念的那句」记下来，局后给一份报告。
 *
 * 为什么需要这一层：声出链（合成 → 虚拟声卡 → 按住说话键）只要有一环不对，用户听到的
 * 是「游戏里突然冒出莫名其妙的声音」或者干脆没声音，而新人此刻既不知道正常该是什么样，
 * 也不知道该信谁。先记账、后出声，把「第一次听见」变成一次可核对的对照，而不是一次赌博。
 *
 * 纪律：影子期间绝不合成、绝不按说话键、绝不灌话筒——不是「音量调 0」，是那段代码根本不跑。
 */
export type ShadowState = 'off' | 'active' | 'done'

export interface ShadowRow {
  at: string
  matchid: string | null
  text: string
}

export interface ShadowReport {
  count: number
  chars: number
  newest: string | null
  sample: ShadowRow[]
}

export interface ShadowInput {
  /** 设置里的开关；关掉就是「一局都不影子」。 */
  enabled: boolean
  /** 已经打完的局数（来自按局归档的 summary，读不到就是 0）。 */
  matchesSeen: number
}

/**
 * 三个状态的分界只有一条：开关开着且还没打完过任何一局 → 正在影子；
 * 打完一局就自动结束（不靠人记得去关，那是最容易忘的一步）。
 */
export function shadowState(input: ShadowInput): ShadowState {
  if (!input.enabled) return 'off'
  return input.matchesSeen > 0 ? 'done' : 'active'
}

/** 影子期间该不该拦下这次出声。`done` 之后一律正常出声。 */
export function shadowBlocks(state: ShadowState): boolean {
  return state === 'active'
}

export function summarizeShadow(rows: readonly ShadowRow[], sampleCount = 3): ShadowReport {
  if (rows.length === 0) return { count: 0, chars: 0, newest: null, sample: [] }
  const newest = rows.reduce((latest, row) => (row.at > latest ? row.at : latest), rows[0].at)
  // 样例按时间倒序取，不按数组顺序：账本是追加写的，改判/补写会让「末尾」不等于「最新」。
  const recent = [...rows].sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : 0))
  return {
    count: rows.length,
    chars: rows.reduce((sum, row) => sum + row.text.length, 0),
    newest,
    sample: recent.slice(0, sampleCount)
  }
}

/** 面板那一行的一句话。三种状态各说各的，别让「影子」变成看不懂的名词。 */
export function shadowLine(state: ShadowState, report: ShadowReport): string {
  if (state === 'off') return '已关：对讲会直接出声'
  if (state === 'active') {
    return report.count > 0
      ? `第一局先不出声：已记下 ${report.count} 句（${report.chars} 字），打完这局给你对照`
      : '第一局先不出声：会如实翻译、也会记账，但不合成、不按键'
  }
  return report.count > 0
    ? `第一局记了 ${report.count} 句（${report.chars} 字），之后的局正常出声`
    : '第一局已打完，之后的局正常出声'
}

/** 面板一行要的全部东西：状态、报告、以及那句话（三者同源，不许各算一遍）。 */
export interface ShadowView {
  state: ShadowState
  report: ShadowReport
  line: string
}

export function shadowView(state: ShadowState, report: ShadowReport): ShadowView {
  return { state, report, line: shadowLine(state, report) }
}
