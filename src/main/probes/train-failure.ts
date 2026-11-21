/**
 * #106 探针：训练失败的诊断。
 *
 * 票面验收：
 * - `each known failure shape maps to its stage` → 每种真实踩过的形状单独一条日志，断言阶段与「那一句人话」；
 * - `an unknown failure keeps the raw tail instead of guessing` → 认不出来的日志必须 `stage: 'unknown'`、
 *   `line: null`，并把原文尾巴原样带回；句子只允许 `失败 (exit N)：<原文>`，不许编一个阶段。
 *
 * 另外钉住两条容易写错的：最后一条匹配才是这次的原因（旧痕迹不能抢答）、证据过长要截断。
 */
import { finishProbe, probeCases } from './harness'
import {
  TRAIN_FAILURE_STAGE_LABELS,
  diagnoseTrainFailure,
  failureLine,
  type TrainFailureStage
} from '@shared/train/failure-diagnosis'

const SHAPE_CASES: Array<{ stage: TrainFailureStage; line: string }> = [
  { stage: 'environment', line: "ModuleNotFoundError: No module named 'funasr'" },
  { stage: 'environment', line: 'FileNotFoundError: [Errno 2] No such file or directory: venv/Scripts/python.exe' },
  { stage: 'checkpoint', line: "KeyError: 'model.pt.ep0.20'" },
  { stage: 'averaging', line: 'RuntimeError: No checkpoints found for averaging' },
  { stage: 'training', line: 'torch.OutOfMemoryError: CUDA out of memory. Tried to allocate 2.00 GiB' },
  { stage: 'export', line: 'UnsupportedOperatorError: Exporting the operator aten::index is not supported' },
  { stage: 'export', line: 'export finished but metadata缺少 vocab_size 字段' },
  { stage: 'data', line: 'json.decoder.JSONDecodeError: Expecting value: line 1 column 1 (char 0)' },
  { stage: 'data', line: 'ValueError: could not load audio /data/asr-ft/G14-L02.wav' }
]

export async function runTrainFailureProbe(): Promise<void> {
  const { cases, push } = probeCases()

  for (const item of SHAPE_CASES) {
    const diagnosis = diagnoseTrainFailure(['[预热] 开始训练', item.line])
    push(
      `形状认得出：${item.line.slice(0, 36)}`,
      diagnosis.stage === item.stage && diagnosis.line !== null,
      `${TRAIN_FAILURE_STAGE_LABELS[diagnosis.stage]} · ${diagnosis.line ?? '(无)'}`
    )
    push(`证据就是那一行原文：${item.line.slice(0, 24)}`, diagnosis.evidence.includes(item.line.slice(0, 18)), diagnosis.evidence)
  }

  // —— 最后一条匹配才是这次的原因：上一轮留下的 OOM 不许抢答 ——
  const mixed = diagnoseTrainFailure(['torch.OutOfMemoryError: CUDA out of memory', '跑完了', "ModuleNotFoundError: No module named 'funasr'"])
  push('旧痕迹不抢答：取最后一条匹配', mixed.stage === 'environment', TRAIN_FAILURE_STAGE_LABELS[mixed.stage])

  // —— 未知形状：不猜，保留原始尾巴 ——
  const unknown = diagnoseTrainFailure(['准备数据', '开始训练', 'RuntimeError: something nobody has seen before', '进程退出'])
  push('未知形状：阶段是 unknown', unknown.stage === 'unknown')
  push('未知形状：不给诊断句（line 为 null）', unknown.line === null)
  push('未知形状：证据是最后一条像错误的行', unknown.evidence.includes('something nobody has seen before'), unknown.evidence)
  push('未知形状：尾巴原样带回（含最后一行）', unknown.tail.length === 4 && unknown.tail[3] === '进程退出', unknown.tail.join(' | '))
  push('收场句保留原文，不编阶段', failureLine(unknown, 1) === '失败 (exit 1)：RuntimeError: something nobody has seen before', failureLine(unknown, 1))

  const emptyLog = diagnoseTrainFailure([])
  push('空日志：unknown 且证据为空', emptyLog.stage === 'unknown' && emptyLog.evidence === '' && emptyLog.tail.length === 0)
  push('空日志收场句只说 exit code', failureLine(emptyLog, null) === '失败 (exit ?)', failureLine(emptyLog, null))

  const plain = diagnoseTrainFailure(['一切正常', '还在跑'])
  push('没有错误行的日志：证据退化为最后一行', plain.evidence === '还在跑', plain.evidence)

  // —— 已知形状的收场句带阶段中文名 ——
  const known = diagnoseTrainFailure(['KeyError: \'model.pt.ep0.20\''])
  push('已知形状收场句写阶段', failureLine(known, 1).startsWith('失败（存盘）：'), failureLine(known, 1))

  // —— 截断：证据与尾巴都不许把整段 traceback 塞进 run 行 ——
  const longLine = `RuntimeError: ${'细节'.repeat(200)}`
  const clipped = diagnoseTrainFailure([longLine])
  push('证据截断到 160 字内', clipped.evidence.length <= 160 && clipped.evidence.endsWith('…'), String(clipped.evidence.length))
  const many = diagnoseTrainFailure(['a', 'b', 'c', 'd', 'e', 'f'], 3)
  push('尾巴长度受 tailSize 限制', many.tail.length === 3 && many.tail[2] === 'f', many.tail.join('>'))

  finishProbe('TRAIN_FAILURE_PROBE', cases)
}