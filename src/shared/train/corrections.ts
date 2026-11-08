/**
 * 纠错样本纯缝（#66）：语音页纠错那一句的原始录音落成自由说样本（`G01-Tnn`），标签 = 改对的那句。
 * 命名与配额判定都在这里——主进程写盘、面板提示与 --train-probe 共用同一份知识，
 * 不然「第几条」「到没到顶」会各有各的算法。
 */

/** 纠错样本固定落在自由说组的目录里（G01，票面指定）；同组的逐句录音（L 键）不算这条配额。 */
export const CORRECTION_GROUP = 'G01'

/** 自由说组最多 200 条 / 200MB：到顶只停写 + 提示，**绝不删旧样本**（那是训练数据）。 */
export interface CorrectionLimits {
  maxTakes: number
  maxBytes: number
}

export const CORRECTION_LIMITS: CorrectionLimits = {
  maxTakes: 200,
  maxBytes: 200 * 1024 * 1024
}

/** 纠错样本的文件键：`G01-Tnn`（至少两位；配额 200 条，编号超过 99 就是三位，别撞车）。 */
export function correctionTakeKey(no: number): string {
  return `${CORRECTION_GROUP}-T${String(no).padStart(2, '0')}`
}

/** 是不是纠错样本键：只认本组 T 键（G01 里同时躺着逐句录音 L01..，它们不进这条配额）。 */
export function isCorrectionTakeKey(key: string): boolean {
  return new RegExp(`^${CORRECTION_GROUP}-T\\d{1,3}$`).test(key)
}

/** 纠错样本键里的序号（不是纠错样本键 → null）：续号与排序共用这一处解析。 */
export function correctionTakeNo(key: string): number | null {
  if (!isCorrectionTakeKey(key)) return null
  return Number(key.slice(`${CORRECTION_GROUP}-T`.length))
}

/**
 * 下一条样本的编号 = 本组已有样本序号的最大值 + 1。
 * 不复用空洞（删掉的号不回填）：号码复用会让账本历史把同一号记成两个不同的句子。
 */
export function nextCorrectionTakeNo(keys: readonly string[]): number {
  let max = 0
  for (const key of keys) {
    const no = correctionTakeNo(key)
    if (no === null) continue
    max = Math.max(max, no)
  }
  return max + 1
}

/** 一次纠错落库的请求（IPC `voice:correction`）：改之前的识别文本 + 改对的那句。 */
export interface FtCorrectionInput {
  transcript: string
  corrected: string
}

/**
 * 纠错落库结果：saved=false 时 key 为空。
 * notice 非空 = 要让人看见的一句话（到顶 / 原音已过期）；开关关着时静默不存，notice 留空。
 */
export interface FtCorrectionSaveResult {
  saved: boolean
  key: string | null
  notice: string | null
}

/** 面板与到顶提示共用的一份事实：自由说组现在多少条、多少字节、到没到顶。 */
export interface FtCorrectionSamples {
  count: number
  bytes: number
  maxCount: number
  maxBytes: number
  atCap: boolean
  /** 非空 = 到顶了：纠错照旧并热词，但不再写样本；旧样本一条不删。 */
  notice: string | null
}

/**
 * 配额判定：条数到顶或「现有 + 下一句」超字节上限都算到顶。
 * `nextBytes` 让写盘前就能判断这一句放不放得下；状态行传 0 只看现状。
 */
export function judgeCorrectionSamples(
  takes: readonly { bytes: number }[],
  nextBytes = 0,
  limits: CorrectionLimits = CORRECTION_LIMITS
): FtCorrectionSamples {
  const count = takes.length
  const bytes = takes.reduce((sum, take) => sum + take.bytes, 0)
  const overCount = count >= limits.maxTakes
  const overBytes = bytes + nextBytes > limits.maxBytes
  const notice = overCount
    ? `自由说组的纠错样本已满 ${limits.maxTakes} 条：这次纠错只并了热词，没存样本（旧样本一条没删，先删几条再继续）`
    : overBytes
      ? `自由说组的纠错样本已到 ${Math.round(limits.maxBytes / 1024 / 1024)} MB：这次纠错只并了热词，没存样本（旧样本一条没删，先删几条再继续）`
      : null
  return {
    count,
    bytes,
    maxCount: limits.maxTakes,
    maxBytes: limits.maxBytes,
    atCap: overCount || overBytes,
    notice
  }
}
