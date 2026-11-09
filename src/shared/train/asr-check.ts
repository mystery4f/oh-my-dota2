/**
 * 全量识别比对（「验收」）：把每条录音喂给现役识别模型，拿结果和稿子原文比。
 *
 * 判定口径只在这里写一遍，主进程和面板都读它：
 * 先去掉标点与空白再比——qwen3 输出带标点、paraformer 根本不输出标点，
 * 逐字严格比会让换了引擎的每一次比对都 100% 判错。
 */

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

/** 比对口径：只留文字与数字，标点、空白、引号全部不参与。 */
const PUNCT_RE = /[\s,，.。!！?？:：;；、'"“”‘’()（）[\]【】<>《》…—–\-_/\\|·~`@#$%^&*+=]/g

export function normalizeSpoken(text: string): string {
  return text.replace(PUNCT_RE, '').toLowerCase()
}

/** 归一化后的编辑距离（两句都是十几个字，用最朴素的一行动态规划就够）。 */
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

/**
 * 差 1 个字、或者错的字占不到 15%，算「差一点」；再差就是「明显错」。
 * 15% 是给长句留的余量：20 个字错 3 个（15%）在听感上仍是同一句。
 */
export function gradeSpoken(expected: string, actual: string): { grade: AsrCheckGrade; distance: number } {
  const left = normalizeSpoken(expected)
  const right = normalizeSpoken(actual)
  const distance = spokenDistance(left, right)
  if (distance === 0) return { grade: 'same', distance }
  const ratio = left.length === 0 ? 1 : distance / left.length
  return { grade: distance <= 1 || ratio <= 0.15 ? 'near' : 'wrong', distance }
}

export function gradeAsrCheck(key: string, expected: string, actual: string): AsrCheckItem {
  return { key, expected, actual, ...gradeSpoken(expected, actual) }
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
