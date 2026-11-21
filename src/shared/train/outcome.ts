import type { TrainRunRecord } from './run'

/**
 * 「这一轮训练最后到底怎样」的唯一判据（#171）。
 *
 * 以前这件事没有唯一答案：`runs.status` 只有五个取值，失败原因与阶段都混在 `error` 那一段人话里，
 * 而「完成（待试听）」「完成，但换模失败」「早停」这些更细的结局只存在于 `manager.finish()` 现拼的
 * `stage` 字符串里、只进日志不落库，重启后谁都反推不出来。
 *
 * 这里只做判定，不写库、不加列、不改任何人的写库路径：输入一条 `TrainRunRecord`，输出结局、一句话与
 * 判据来自哪个字段，面板照着显示。判不出来就不许说——`params.epochs` 缺失（老行常见）一律落 `trained`，
 * 绝不拿「epochs 非零」之类的旁证去猜早停。
 */
export type RunOutcome =
  | 'running'
  | 'trained'
  | 'applied'
  | 'awaiting-audition'
  | 'early-stop'
  | 'failed'
  | 'stopped'

export const RUN_OUTCOMES: readonly RunOutcome[] = [
  'running',
  'trained',
  'applied',
  'awaiting-audition',
  'early-stop',
  'failed',
  'stopped'
]

/** 顺序只写在 `judgeRunOutcome()` 里一处；这张表只管显示名。 */
export const RUN_OUTCOME_LABELS: Record<RunOutcome, string> = {
  running: '进行中',
  trained: '已训练',
  applied: '已应用',
  'awaiting-audition': '待试听',
  'early-stop': '早停',
  failed: '失败',
  stopped: '已停止'
}

export interface RunOutcomeVerdict {
  outcome: RunOutcome
  /**
   * 一行话，直接给面板显示。
   *
   * `failed` 时这里是 `run.error` 的**原文**（逐字节相同）：失败原因可以有几百字、可以带模型名与路径，
   * 改写它等于让人对着改写后的句子排查。面板要排版可以自己截断，函数返回值不许动。
   */
  line: string
  /** 判据来自哪个字段，写给人看：`status=failed`、`metrics.epochs=3 < params.epochs=5` 这种。 */
  evidence: string
}

/**
 * 判据顺序（先命中者胜），全部只用盘上已有字段：
 *
 * 1. `running` / `2. stopped` / `3. failed` / 4. `applied` 为真 / 5. ASR 训完且两种试听记录都为空 /
 * 6. 跑完但有 `params.epochs` 且 `metrics.epochs` 更小 / 7. 其余 `trained`。
 *
 * 之所以 `applied` 排在「待试听」前面：转正之后就不该再有人在试听那块等它（`applied` 只会由应用新模型
 * 那一步写上，`audition` 可能还留着快照，那是历史不是待办）。
 */
export function judgeRunOutcome(run: TrainRunRecord): RunOutcomeVerdict {
  if (run.status === 'running') {
    return { outcome: 'running', line: '还在跑', evidence: 'status=running' }
  }
  if (run.status === 'stopped') {
    return { outcome: 'stopped', line: '你自己停的', evidence: 'status=stopped' }
  }
  if (run.status === 'failed') {
    // 原文照抄：`error` 为空是「当时没写下来」，不是「没有失败」。
    return {
      outcome: 'failed',
      line: run.error ?? '',
      evidence: run.error === null ? 'status=failed, error=null' : 'status=failed, error=原样'
    }
  }
  if (run.applied) {
    return { outcome: 'applied', line: '训练完并已转正', evidence: 'applied=true' }
  }
  if (run.kind === 'asr-ft' && run.status === 'trained' && run.audition === null && run.auditionSkip === null) {
    return {
      outcome: 'awaiting-audition',
      line: '训练完，等着试听对比',
      evidence: 'kind=asr-ft, status=trained, audition=null, auditionSkip=null'
    }
  }
  // 早停只认「计划轮数写下来过，而且确实少跑了」：老行没有 params.epochs 时这里必须落 trained。
  const planned = run.params.epochs
  const done = run.metrics?.epochs ?? null
  if (run.status === 'trained' && typeof planned === 'number' && planned > 0 && done !== null && done < planned) {
    return {
      outcome: 'early-stop',
      line: `跑完但没跑满计划轮数（${done} / ${planned}）`,
      evidence: `metrics.epochs=${done} < params.epochs=${planned}`
    }
  }
  return {
    outcome: 'trained',
    line: '训练完成',
    evidence: planned === undefined || planned === null ? 'status=trained, params.epochs 未记录' : 'status=trained'
  }
}
