/**
 * 音色训练的数据量（#180）：几条录音、总共多长、最近一条什么时候收的。
 *
 * 为什么需要：`judgeGvDataset()` 只答「四件套齐没齐」——十条录音也齐、五百条也齐，
 * 而「数据不够还硬训」是同一页最容易犯的错（训出来的声音走音，十几分钟后才知道）。
 *
 * 四条口径：
 *   - 句数以 `2-name2text.txt` 的行数为准（一行一句），最多数 `GV_LINE_CAP` 行，到顶就写「N+」。
 *   - 时长是**估**的：读 `5-wav32k/` 里前 `GV_WAV_SAMPLE` 个 wav 的头算平均，再乘条数。
 *     读不出来的文件跳过并计数；跳过超过一半时不再给「约」，只说测不到。
 *   - 最近一条 = `5-wav32k/` 里所有 wav 的 `mtime` 最大值（只 stat，不读内容）。
 *   - 「够不够」只在这里判（`judgeGvSize`），页面只负责显示，不许再判一次。
 */

/** 够不够：40 句或 5 分钟，任一不足就提示（不是两个都要不足）。 */
export const GV_THIN_SENTENCES = 40
export const GV_THIN_SECONDS = 300

/** 行数上界：几万行的音素表数到底也不会改变结论。 */
export const GV_LINE_CAP = 20_000

/** 时长采样上界：读这么多个 wav 头算平均。 */
export const GV_WAV_SAMPLE = 40

/** 句数与 wav 个数差到这个比例就说「标签和录音对不上」（0.1 = 10%）。 */
export const GV_MISMATCH_RATIO = 0.1

/** 主进程读到的事实（纯缝只折叠，不读盘）。 */
export interface GvStatsFacts {
  /** `2-name2text.txt` 的行数；`null` = 这份文件不在。 */
  lines: number | null
  /** 数到了 `GV_LINE_CAP` 上限，行数只是个下界。 */
  capped: boolean
  /** `5-wav32k/` 里的 wav 个数；`null` = 目录不在。 */
  wavCount: number | null
  /** 采样读到的每个 wav 的时长（毫秒）。 */
  sampledMs: readonly number[]
  /** 采样里读不出时长的 wav 个数。 */
  skipped: number
  /** `5-wav32k/` 里最新的 mtime；`null` = 没有 wav。 */
  newestAt: number | null
}

export interface GvDatasetStats {
  /** 句数（音素表行数）；`null` = 没有音素表。 */
  sentences: number | null
  /** 句数的展示文本（到顶带「+」）。 */
  sentencesText: string
  wavCount: number | null
  /** 估算的总时长（毫秒）；`null` = 测不到。 */
  totalMs: number | null
  /** 总时长是估的还是实测的（全部 wav 都读到了才算实测）。 */
  estimated: boolean
  newestAt: number | null
  /** 算法自述：读了几分之几、平均多少毫秒、跳过几个 —— 报告里要写清来源。 */
  basis: string
}

export type GvSizeState = 'ok' | 'thin' | 'unknown'

export interface GvSizeVerdict {
  state: GvSizeState
  /** 一句人话：够 / 不够（说缺多少）/ 缺哪一项（说清已经知道了什么）。 */
  line: string
}

export function sentenceText(facts: GvStatsFacts): string {
  if (facts.lines === null) return '没有音素表'
  return facts.capped ? `${facts.lines}+` : String(facts.lines)
}

export function summarizeGvDataset(facts: GvStatsFacts): GvDatasetStats {
  const sampled = facts.sampledMs.length
  const averageMs = sampled === 0 ? 0 : facts.sampledMs.reduce((sum, one) => sum + one, 0) / sampled
  const wavCount = facts.wavCount
  const sentences = facts.lines
  const counted = Math.max(sentences ?? 0, wavCount ?? 0)
  // 一个头都没读出来、或者一半以上读不出来 → 不给数，只说测不到。
  const hopeless = sampled === 0 || facts.skipped > sampled
  const totalMs = hopeless || sentences === null || counted === 0 ? null : Math.round(averageMs * counted)
  const estimated = totalMs === null ? false : !(wavCount !== null && facts.skipped === 0 && sampled >= wavCount && sentences === wavCount)
  const basis =
    sampled === 0
      ? `没读到 wav 头（跳过 ${facts.skipped} 个）`
      : `读前 ${sampled}/${wavCount ?? 0} 个 wav 头的平均 ${Math.round(averageMs)} ms × ${counted} 条${
          estimated ? '（估）' : '（实测）'
        }${facts.skipped > 0 ? `，跳过 ${facts.skipped} 个读不了` : ''}`
  return {
    sentences,
    sentencesText: sentenceText(facts),
    wavCount,
    totalMs,
    estimated,
    newestAt: facts.newestAt,
    basis
  }
}

function minutes(ms: number): string {
  const value = ms / 60_000
  return value >= 10 ? String(Math.round(value)) : value.toFixed(1)
}

function recentText(at: number | null, now: number): string {
  if (at === null) return '最近一条时间不详'
  const days = Math.floor((now - at) / 86_400_000)
  if (days <= 0) return '最近一条是今天'
  return `最近一条 ${days} 天前`
}

function mismatchText(stats: GvDatasetStats): string | null {
  const { sentences, wavCount } = stats
  if (sentences === null || wavCount === null || wavCount === 0) return null
  const diff = Math.abs(sentences - wavCount) / Math.max(sentences, wavCount)
  if (diff <= GV_MISMATCH_RATIO) return null
  return `标签 ${stats.sentencesText} 句和录音 ${wavCount} 个差得多：先对一遍名单再训`
}

/** 「够不够」的结论。页面只显示，不许再判一次。 */
export function judgeGvSize(stats: GvDatasetStats, now = Date.now()): GvSizeVerdict {
  if (stats.sentences === null) {
    // 只有 wav、没有音素表：知道一半，就说这一半。
    if (stats.wavCount !== null && stats.wavCount > 0) {
      return {
        state: 'unknown',
        line: `有 ${stats.wavCount} 个录音但还没有音素表（2-name2text.txt）：先打标注 · ${recentText(stats.newestAt, now)}`
      }
    }
    return { state: 'unknown', line: '还没有备料：先让 webui 生成 2-name2text.txt' }
  }
  if (stats.sentences === 0) {
    return { state: 'thin', line: '音素表是空的（0 句）：先补录音再打标注' }
  }
  const tail = recentText(stats.newestAt, now)
  const mismatch = mismatchText(stats)
  if (stats.totalMs === null) {
    return {
      state: 'unknown',
      line: `${stats.sentencesText} 句 · 时长测不到（5-wav32k/ 里的 wav 头读不出来）· ${tail}`
    }
  }
  const head = `${stats.sentencesText} 句 · ${stats.estimated ? '约 ' : ''}${minutes(stats.totalMs)} 分钟 · ${tail}`
  const shortSentences = (stats.sentences ?? 0) < GV_THIN_SENTENCES
  const shortSeconds = stats.totalMs / 1000 < GV_THIN_SECONDS
  if (shortSentences || shortSeconds) {
    const need: string[] = []
    if (shortSentences) need.push(`至少 ${GV_THIN_SENTENCES} 句（现在 ${stats.sentencesText}）`)
    if (shortSeconds) need.push(`总长至少 ${Math.round(GV_THIN_SECONDS / 60)} 分钟（现在 ${stats.estimated ? '约 ' : ''}${minutes(stats.totalMs)}）`)
    return { state: 'thin', line: `${head} · 偏少：${need.join('、')}` }
  }
  if (mismatch) return { state: 'thin', line: `${head} · ${mismatch}` }
  return { state: 'ok', line: head }
}