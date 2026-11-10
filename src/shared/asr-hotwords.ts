/**
 * 热词表的纯函数缝：解析、纠错差异提取、合并。
 * 只做字符串处理，零依赖；`--asr-hotwords-probe` 全量锁这些行为。
 */

/** 词表分隔符：英文逗号、中文逗号、顿号、分号、空白。 */
const HOTWORD_SPLIT = /[,，、;；\s]+/

/**
 * 把热词字符串解析成去重词列表；空串返回空数组。
 */
export function parseHotwords(raw: string): string[] {
  const seen = new Set<string>()
  for (const piece of raw.split(HOTWORD_SPLIT)) {
    const word = piece.trim()
    if (word) seen.add(word)
  }
  return [...seen]
}

/**
 * 把词列表拼回规范化的存储串（统一英文逗号分隔）。
 */
export function joinHotwords(words: string[]): string {
  return words.join(',')
}

/**
 * 从纠错前后的两段转写里提取「改对的部分」，作为要并入热词的候选词。
 * 做法：去掉公共前后缀得到差异区间，再按标点切出干净的片段；
 * 只保留 ≥2 字的片段（单字噪声太大），一次纠错最多并入 8 个，天然去重。
 */
export function extractHotwordDiff(oldText: string, newText: string): string[] {
  let start = 0
  const minLen = Math.min(oldText.length, newText.length)
  while (start < minLen && oldText[start] === newText[start]) start++
  let endOld = oldText.length
  let endNew = newText.length
  while (endOld > start && endNew > start && oldText[endOld - 1] === newText[endNew - 1]) {
    endOld--
    endNew--
  }
  const changed = newText.slice(start, endNew)
  const words: string[] = []
  for (const piece of changed.split(/[，。？！、；：,.?!;:\s]+/)) {
    const word = piece.trim()
    if (word.length >= 2) words.push(word)
  }
  return [...new Set(words)].slice(0, 8)
}

/** 热词表容量上限：sherpa 热词是构造期配置，词太多拖慢识别也稀释效果；面板编辑与纠错并入共用这一条。 */
export const HOTWORD_LIMIT = 50

/**
 * 把新词并入现有词表串，返回规范化后的新串；已在表里的词不重复。
 * 表满后不再追加：现役词优先，新词直接丢弃（面板在提交前拦人，纠错并入在这里兜底）。
 */
export function mergeHotwords(existing: string, additions: string[]): string {
  const merged = parseHotwords(existing)
  for (const word of additions) {
    if (merged.length >= HOTWORD_LIMIT) break
    if (!merged.includes(word)) merged.push(word)
  }
  return joinHotwords(merged)
}
