/**
 * 逐条错误率（CER）：训练管理「测一遍」的判定口径只写在这里，主进程、面板和探针都读它。
 *
 * 为什么三档（一致 / 差一点 / 明显错）不够：三档说不出「这一版比上一版好了多少」，
 * 也排不出「哪几句最该重录」。CER = 错字数 ÷ 原文字数，跨句子长度可比、两次测量可取平均。
 * 分母是归一化之后的原文字数（标点与空白不算字），归一化和识别比对共用一套。
 */

/** 比对口径：只留文字与数字，标点、空白、引号全部不参与。 */
const PUNCT_RE = /[\s,，.。!！?？:：;；、'"“”‘’()（）[\]【】<>《》…—–\-_/\\·~`@#$%^&*+=|]/g

/** 归一化：去掉标点与空白，统一小写。qwen3 带标点、paraformer 不带，逐字严格比会让换引擎的每次比对全判错。 */
export function normalizeSpoken(text: string): string {
  return text.replace(PUNCT_RE, '').toLowerCase()
}

/** 归一化后的编辑距离（两句都是十几个字，最朴素的一行动态规划就够）。 */
export function spokenDistance(a: string, b: string): number {
  if (a === b) return 0
  const prev = new Array<number>(b.length + 1)
  for (let j = 0; j <= b.length; j++) prev[j] = j
  for (let i = 1; i <= a.length; i++) {
    let diagonal = prev[0]
    prev[0] = i
    for (let j = 1; j <= b.length; j++) {
      const up = prev[j]
      prev[j] = Math.min(prev[j] + 1, prev[j - 1] + 1, diagonal + (a[i - 1] === b[j - 1] ? 0 : 1))
      diagonal = up
    }
  }
  return prev[b.length]
}

export interface CerMeasure {
  /** 归一化后的错字数（编辑距离）。 */
  distance: number
  /** 归一化后的原文字数，也就是分母。 */
  chars: number
  /** distance / chars；原文为空而识别结果有字时记 1，不给无穷大。 */
  cer: number
}

/**
 * 一句的 CER。
 *
 * 原文归一化后为空（只有标点、或者稿子那行本来就是空的）时没有分母可言：
 * 识别结果也为空算 0 错，有字算全错（1）——这种行本来就该被稿子修掉，不该出现一个 NaN 卡住排序。
 */
export function measureCer(expected: string, actual: string): CerMeasure {
  const left = normalizeSpoken(expected)
  const right = normalizeSpoken(actual)
  const distance = spokenDistance(left, right)
  const chars = left.length
  if (chars === 0) return { distance, chars: 0, cer: distance === 0 ? 0 : 1 }
  return { distance, chars, cer: distance / chars }
}

/** 这条录音在切分里属于哪一边：训练集里见过（量记忆），还是留出没见过（量泛化）。 */
export type CerCohort = 'train' | 'eval' | 'unknown'

export interface CerRow extends CerMeasure {
  key: string
  cohort: CerCohort
}

/**
 * 排名：错得最狠的排前面。
 * 同率时字数多的先——二十个字错四个比五个字错一个更说明问题；再相同就按 key，保证两次运行顺序一致。
 */
export function rankByCer<T extends CerRow>(rows: readonly T[]): T[] {
  return [...rows].sort((a, b) => b.cer - a.cer || b.chars - a.chars || a.key.localeCompare(b.key))
}

export interface CerSummary {
  rows: number
  distance: number
  chars: number
  /** 合计 CER：总错字 ÷ 总字数。 */
  cer: number
  /** 一个字都没错的行数。 */
  clean: number
}

/**
 * 一组的合计 CER：**总错字 ÷ 总字数**，不是各条 CER 的平均。
 * 平均会让一条 3 字全错（100%）压过一条 30 字全对，而后者才是这批数据的主体。
 */
export function summarizeCer(rows: readonly CerRow[]): CerSummary {
  const distance = rows.reduce((sum, row) => sum + row.distance, 0)
  const chars = rows.reduce((sum, row) => sum + row.chars, 0)
  const cer = chars === 0 ? (distance === 0 ? 0 : 1) : distance / chars
  return { rows: rows.length, distance, chars, cer, clean: rows.filter((row) => row.distance === 0).length }
}

/**
 * 按队列拆开数：`train`（训练里见过）与 `eval`（留出没见过）必须分开报。
 * 只报 in-sample 是自欺——见过的句子当然认得，量不到泛化；`unknown` 是账本没记切分的老数据，
 * 单独一档，不能偷偷并进任何一边。
 */
export function summarizeCerByCohort(rows: readonly CerRow[]): Record<CerCohort, CerSummary> {
  return {
    train: summarizeCer(rows.filter((row) => row.cohort === 'train')),
    eval: summarizeCer(rows.filter((row) => row.cohort === 'eval')),
    unknown: summarizeCer(rows.filter((row) => row.cohort === 'unknown'))
  }
}

/** 百分比展示：一位小数够用，0 错写 0%，别写成 0.0%。 */
export function formatCer(cer: number): string {
  if (!Number.isFinite(cer) || cer <= 0) return '0%'
  const percent = cer * 100
  if (percent < 1) return `${percent.toFixed(1)}%`
  return `${percent.toFixed(percent < 10 ? 1 : 0)}%`
}
