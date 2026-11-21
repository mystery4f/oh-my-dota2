/**
 * #106：训练失败的诊断。
 *
 * 为什么要有这一层：现在失败收场只把日志尾巴原样塞进 run 行（`失败 (exit 1)：RuntimeError: …`），
 * 用户得自己去几百行 Python traceback 里找「到底哪一步坏了」。这里把**已知的失败形状**映射成
 * 「阶段 + 一句人话」，并把原文当证据留着；未知形状一律不猜——保留原始尾巴，因为猜错的诊断比没有更糟。
 *
 * 已知形状全部来自真实踩过的坑（`docs/NOTES.md` 的 FunASR 三条约束、训练环境缺包、导出缺件）。
 */

/** 失败发生在哪一步。`unknown` 是诚实的默认值，不许拿它当「训练」糊过去。 */
export type TrainFailureStage = 'environment' | 'data' | 'checkpoint' | 'training' | 'averaging' | 'export' | 'unknown'

export interface TrainFailureDiagnosis {
  stage: TrainFailureStage
  /** 一句人话；`unknown` 时为 null（没有诊断就是没有）。 */
  line: string | null
  /** 命中的那一行原文（截断）；`unknown` 时是最后一条看起来像错误的行，再退化为最后一行。 */
  evidence: string
  /** 日志尾部原文，顺序不变：诊断之外，用户还能自己看。 */
  tail: string[]
}

/** 阶段的中文名：日志、面板、口碑都用这一份。 */
export const TRAIN_FAILURE_STAGE_LABELS: Record<TrainFailureStage, string> = {
  environment: '环境',
  data: '数据',
  checkpoint: '存盘',
  training: '训练',
  averaging: '收尾',
  export: '导出',
  unknown: '未识别'
}

interface FailureShape {
  stage: TrainFailureStage
  test: RegExp
  line: string
}

/**
 * 顺序有讲究：越具体的放前面。`checkpoint` 的两条来自 FunASR 的 validate_interval 陷阱
 * （`KeyError: 'model.pt.ep0.20'` 与 `No checkpoints found for averaging`），指向的是同一个根因的两半。
 */
const SHAPES: FailureShape[] = [
  {
    stage: 'environment',
    test: /ModuleNotFoundError: No module named '([\w.]+)'/,
    line: '训练环境缺 Python 包（日志里有 ModuleNotFoundError）：到识别训练的环境页补装依赖，再重跑'
  },
  {
    stage: 'environment',
    test: /FileNotFoundError: .*(python|venv|runtime).*|No such file or directory: .*(python|runtime)/i,
    line: '找不到 Python 解释器或训练脚本：训练环境的路径变了，重新指向一次'
  },
  {
    stage: 'checkpoint',
    test: /KeyError: ['"]model\.pt\.ep/,
    line: '存盘时撞到空的校验表：validate_interval 必须等于 save_checkpoint_interval（FunASR 的已知坑）'
  },
  {
    stage: 'averaging',
    test: /No checkpoints found for averaging/,
    line: '收尾挑权重时挑中了不存在的文件：keep_nbest_models 至少 2，且校验间隔与存盘间隔一致'
  },
  {
    stage: 'training',
    test: /CUDA out of memory|OutOfMemoryError/i,
    line: '显存不足（CUDA OOM）：关掉占卡的程序（游戏、别的推理服务）再点一次'
  },
  {
    stage: 'export',
    test: /torch\.onnx|onnx export|Exporting the operator|UnsupportedOperatorError/i,
    line: '导出 ONNX 失败：日志里点名了不支持的算子，换导出参数或回退到上一版权重'
  },
  {
    stage: 'export',
    test: /metadata|vocab_size|tokens\.txt/i,
    line: '导出产物缺 sherpa 需要的元数据（vocab_size / tokens.txt 之类），导出腿没有跑完'
  },
  {
    stage: 'data',
    test: /JSONDecodeError|Expecting value: line/i,
    line: '训练数据里有一份不是合法 JSON（FunASR 的 jsonl 清单）：先重打包数据集'
  },
  {
    stage: 'data',
    test: /ValueError: .*audio|soundfile|librosa|wave/i,
    line: '有一段录音读不出来（不是 16k 单声道 wav 或文件损坏）：在数据体检里找出那一条重录'
  }
]

/** 最后一条像错误的行：traceback 的最后一行才是结论，前面都是栈。 */
const ERROR_LINE_RE = /(?:Error|Exception|error)\b.*/

function clip(text: string, limit = 160): string {
  const trimmed = text.trim()
  return trimmed.length > limit ? `${trimmed.slice(0, limit - 3)}…` : trimmed
}

/**
 * 从日志行里诊断失败。**从后往前**找：一次失败的最后一条匹配才是这次的原因，
 * 前面同形状的旧痕迹（上一轮留下的）不能抢答。
 */
export function diagnoseTrainFailure(lines: readonly string[], tailSize = 8): TrainFailureDiagnosis {
  const tail = lines.slice(-Math.max(1, tailSize)).map((line) => clip(line, 200))
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = lines[index] ?? ''
    for (const shape of SHAPES) {
      if (!shape.test.test(text)) continue
      return { stage: shape.stage, line: shape.line, evidence: clip(text), tail }
    }
  }
  // 没认出来：把最后一条像错误的行当证据，连它都没有就取最后一行；绝不给一句编出来的诊断。
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const text = (lines[index] ?? '').trim()
    if (text !== '' && ERROR_LINE_RE.test(text)) return { stage: 'unknown', line: null, evidence: clip(text), tail }
  }
  const last = lines.length > 0 ? clip(lines[lines.length - 1] ?? '') : ''
  return { stage: 'unknown', line: null, evidence: last, tail }
}

/** 收场那一行：已知形状给「阶段：人话」，未知形状保留原文（不许只说「失败」）。 */
export function failureLine(diagnosis: TrainFailureDiagnosis, exitCode: number | null): string {
  const code = exitCode === null ? '?' : String(exitCode)
  if (diagnosis.line === null) {
    return diagnosis.evidence === '' ? `失败 (exit ${code})` : `失败 (exit ${code})：${diagnosis.evidence}`
  }
  return `失败（${TRAIN_FAILURE_STAGE_LABELS[diagnosis.stage]}）：${diagnosis.line}`
}