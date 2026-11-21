/**
 * 试听对比（#105）：转正之前，让同一批留出集录音在两副模型上各跑一遍，把结果并排给人看。
 *
 * 纯缝：只做「两串识别结果 + 标准答案」的比较与文案；转写与落库都在调用方，
 * 探针用假转写钉住「两边看到的是同一批录音」这条验收。
 *
 * 三个约定：
 * - 两副模型的输入永远是同一份 `AuditionPair[]`（同一个 key、同一段 wav、同一个标准答案），
 *   不存在「A 模型听这段、B 模型听那段」的对照——那种数字没法比；
 * - 判好坏只看 CER（总错字 ÷ 总字数），不看「识别得更长」这类旁证；
 * - 一句识别成空串按全错算，不跳过：跳过的句子会让好模型显得更好看。
 */
import { formatCer, measureCer } from './cer'

/** 一侧的识别结果与另一侧并排，key 是录音键（G14-L03 这种），面板按它贴回录音行。 */
export interface AuditionPair {
  key: string
  /** 稿子里的标准答案。 */
  expected: string
  /** 现役（转正前）模型的识别结果。 */
  before: string
  /** 新模型的识别结果。 */
  after: string
}

/** 一句的胜负：新模型更好 / 更差 / 一样。 */
export type AuditionSide = 'before' | 'after' | 'same'

export interface AuditionRow extends AuditionPair {
  beforeCer: number
  afterCer: number
  /** 这一句谁更好（`after` = 新模型）。 */
  better: AuditionSide
}

/** 整批结论：落到 run 行上，面板只读它，不再自己算。 */
export interface FtAudition {
  /** 最多 AUDITION_MAX_ROWS 行（优先放有差异的句子）。 */
  rows: AuditionRow[]
  /** 实际试听的句数（rows 可能被截断，这个数是准数）。 */
  count: number
  /** 新模型更好的句数。 */
  better: number
  /** 新模型更差的句数。 */
  worse: number
  /** 两边一样的句数。 */
  same: number
  /** 现役模型的整批 CER（总错字 ÷ 总字数）。 */
  beforeCer: number
  /** 新模型的整批 CER。 */
  afterCer: number
  verdict: 'better' | 'worse' | 'same'
  at: number
}

/** 跳过试听的记录：`auto` 为真表示不是人点的（例如没有留出集，跑不了对比）。 */
export interface FtAuditionSkip {
  at: number
  auto: boolean
  reason: string
}

/** 面板表格最多摆这么多行：再多就没人看了，结论数仍是全量。 */
export const AUDITION_MAX_ROWS = 8

function cerOf(expected: string, text: string): number {
  return measureCer(expected, text).cer
}

function sideOf(beforeCer: number, afterCer: number): AuditionSide {
  if (afterCer < beforeCer) return 'after'
  if (afterCer > beforeCer) return 'before'
  return 'same'
}

/** 逐句算 CER 与胜负（纯计算，顺序与输入一致）。 */
export function auditionRows(pairs: readonly AuditionPair[]): AuditionRow[] {
  return pairs.map((pair) => {
    const beforeCer = cerOf(pair.expected, pair.before)
    const afterCer = cerOf(pair.expected, pair.after)
    return { ...pair, beforeCer, afterCer, better: sideOf(beforeCer, afterCer) }
  })
}

/** 整批判定：先按「有差异的行优先」排一遍再截断，结论数仍按全量算。 */
export function judgeAudition(pairs: readonly AuditionPair[], at: number): FtAudition {
  const all = auditionRows(pairs)
  let beforeErrors = 0
  let afterErrors = 0
  let chars = 0
  let better = 0
  let worse = 0
  let same = 0
  for (const row of all) {
    beforeErrors += measureCer(row.expected, row.before).distance
    afterErrors += measureCer(row.expected, row.after).distance
    chars += measureCer(row.expected, row.after).chars
    if (row.better === 'after') better += 1
    else if (row.better === 'before') worse += 1
    else same += 1
  }
  const beforeCer = chars === 0 ? 0 : beforeErrors / chars
  const afterCer = chars === 0 ? 0 : afterErrors / chars
  const interesting = all.filter((row) => row.better !== 'same')
  const boring = all.filter((row) => row.better === 'same')
  return {
    rows: [...interesting, ...boring].slice(0, AUDITION_MAX_ROWS),
    count: all.length,
    better,
    worse,
    same,
    beforeCer,
    afterCer,
    verdict: sideOf(beforeCer, afterCer) === 'after' ? 'better' : sideOf(beforeCer, afterCer) === 'before' ? 'worse' : 'same',
    at
  }
}

/** 面板/日志共用的一句话：句数、胜负、两边的 CER 方向。 */
export function auditionLine(audition: FtAudition): string {
  if (audition.count === 0) return '这次没试听（没有留出集可听）'
  return `试听 ${audition.count} 句：新模型好 ${audition.better}、差 ${audition.worse}、一样 ${audition.same} · CER ${formatCer(audition.beforeCer)} → ${formatCer(audition.afterCer)}`
}

/** 跳过的说法：人点的与自动跳过分得清，理由照原样写出。 */
export function auditionSkipLine(skip: FtAuditionSkip): string {
  const who = skip.auto ? '自动跳过试听' : '跳过试听'
  return skip.reason ? `${who}（${skip.reason}）` : who
}