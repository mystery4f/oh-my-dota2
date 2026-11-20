/**
 * 全量识别比对（「验收」）：把每条录音喂给现役识别模型，拿结果和稿子原文比。
 *
 * 判定口径只在这里写一遍，主进程和面板都读它：
 * 先去掉标点与空白再比——qwen3 输出带标点、paraformer 根本不输出标点，
 * 逐字严格比会让换了引擎的每一次比对都 100% 判错。
 *
 * 归一化与编辑距离住在 `./cer`：同一份错字数既是分档的依据，也是 CER 的分子，
 * 两处各算一遍迟早会不一致。这里只管「错到什么程度算差一点」。
 */
import { measureCer, type CerCohort } from './cer'

export type AsrCheckGrade = 'same' | 'near' | 'wrong'

export interface AsrCheckItem {
  key: string
  /** 稿子里那句（打包用的标签）。 */
  expected: string
  /** 识别结果原样（带标点），列表里给人看的就是这一份。 */
  actual: string
  grade: AsrCheckGrade
  /** 归一化之后的编辑距离：same 恒为 0。 */
  distance: number
  /** 归一化之后的原文字数：CER 的分母。 */
  chars: number
  /** 逐条错误率 distance / chars（口径见 `./cer`）。 */
  cer: number
  /** 这条录音属于训练集还是留出集；账本没记切分时 unknown。 */
  cohort: CerCohort
}

export interface AsrCheckState {
  running: boolean
  /** 已经跑完的条数 / 总数（总数在开跑那一刻定下）。 */
  done: number
  total: number
  /** 正在跑的那一条的 key，跑完为空串。 */
  current: string
  startedAt: number
  finishedAt: number
  error: string | null
  canceled: boolean
  items: AsrCheckItem[]
}

export function emptyAsrCheckState(): AsrCheckState {
  return { running: false, done: 0, total: 0, current: '', startedAt: 0, finishedAt: 0, error: null, canceled: false, items: [] }
}

/**
 * 差 1 个字、或者错的字占不到 15%，算「差一点」；再差就是「明显错」。
 * 15% 是给长句留的余量：20 个字错 3 个（15%）在听感上仍是同一句。
 */
export function gradeSpoken(expected: string, actual: string): { grade: AsrCheckGrade; distance: number } {
  const { distance, chars, cer } = measureCer(expected, actual)
  if (distance === 0) return { grade: 'same', distance }
  const ratio = chars === 0 ? 1 : cer
  return { grade: distance <= 1 || ratio <= 0.15 ? 'near' : 'wrong', distance }
}

/**
 * 一条比对结果。队列默认 `unknown`：切分只有调用方（主进程按账本与打包口径）知道，
 * 这里不去猜——猜错会把「没见过的句子」报成「训练过的」，那是把泛化数字做假。
 */
export function gradeAsrCheck(key: string, expected: string, actual: string): AsrCheckItem {
  const { distance, chars, cer } = measureCer(expected, actual)
  const ratio = chars === 0 ? 1 : cer
  const grade: AsrCheckGrade = distance === 0 ? 'same' : distance <= 1 || ratio <= 0.15 ? 'near' : 'wrong'
  return { key, expected, actual, grade, distance, chars, cer, cohort: 'unknown' }
}

/** 汇总一行：面板顶部与探针都读这份，别各自数一遍。 */
export function summarizeAsrCheck(items: readonly AsrCheckItem[]): {
  same: number
  near: number
  wrong: number
  total: number
} {
  return {
    same: items.filter((item) => item.grade === 'same').length,
    near: items.filter((item) => item.grade === 'near').length,
    wrong: items.filter((item) => item.grade === 'wrong').length,
    total: items.length
  }
}
