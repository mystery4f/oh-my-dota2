/** 录音判定纯缝（录音面板）：何时停（advanceRecording）、收不收（shouldKeepTake）、段叫什么（takeLineId/recordingKey）。 */
/** 试点（G15，20 句）实测阈值；改任何一项之前先过 --train-probe，再真人试录一遍。 */
export const RECORDING_LIMITS = {
  rmsThreshold: 0.012,
  quietMsToStop: 1200,
  minMs: 400,
  maxMs: 20000,
} as const

/** 一次录音的步进状态：探没探到说话、静音武装起于何时、从何时起录。 */
export interface RecordingStepState {
  speechSeen: boolean
  quietSince: number // 0 = 静音还没武装：说完话后的第一块安静样本才起表
  startedAt: number
}

/** 开录那一刻的状态。 */
export function initialRecordingState(nowMs: number): RecordingStepState {
  return { speechSeen: false, quietSince: 0, startedAt: nowMs }
}

/**
 * 每块音频走一步：超阈值记「说过话」并解除静音武装；说完连静 quietMsToStop 自动停
 * （读稿节奏就是句间停一秒），maxMs 硬上限兜底。静音时限先判、上限后判，同一步都命中
 * 时 reason 归先判中的。只做决策，不碰 MediaStream——采样管线留在渲染端。
 */
export function advanceRecording(
  state: RecordingStepState,
  input: { rms: number; nowMs: number },
): { state: RecordingStepState; stop: boolean; reason: string | null } {
  const next: RecordingStepState = { ...state }
  let stop = false
  let reason: string | null = null
  if (input.rms >= RECORDING_LIMITS.rmsThreshold) {
    next.speechSeen = true
    next.quietSince = 0
  } else if (next.speechSeen) {
    if (!next.quietSince) next.quietSince = input.nowMs
    else if (input.nowMs - next.quietSince >= RECORDING_LIMITS.quietMsToStop) {
      stop = true
      reason = '自动停'
    }
  }
  if (!stop && input.nowMs - next.startedAt >= RECORDING_LIMITS.maxMs) {
    stop = true
    reason = `到 ${RECORDING_LIMITS.maxMs / 1000}s 上限`
  }
  return { state: next, stop, reason }
}

/**
 * 收尾判定：太短丢；全程没探到说话（哑麦/阈值漏探）的静音段也丢——静音配稿子是脏样本。
 * 时长判定在前，两条件同犯时报「太短」。
 */
export function shouldKeepTake({ durationMs, speechSeen }: { durationMs: number; speechSeen: boolean }): {
  keep: boolean
  reason: string | null
} {
  if (durationMs < RECORDING_LIMITS.minMs) return { keep: false, reason: `太短（${durationMs}ms），丢弃了——重新点录制` }
  if (!speechSeen) return { keep: false, reason: '没检测到说话，丢弃——重新点录制' }
  return { keep: true, reason: null }
}

/** 段序号键：逐句组 L+两位序号，自由说组 T+两位序号。 */
export function takeLineId(mode: 'lines' | 'free', no: number): string {
  return `${mode === 'free' ? 'T' : 'L'}${String(no).padStart(2, '0')}`
}

/** 录音键的合法形状：组 Gxx、句 Lxx（逐句）或 Txx（自由说）。格式化与主进程写盘白名单共用这一条知识。 */
export const RECORDING_GROUP_SHAPE = /^G\d{2}$/
export const RECORDING_LINE_SHAPE = /^(?:L|T)\d{2}$/

/** 校验并归一（组号，句号）字符串对，非法输入抛错；主进程写盘靠它防路径穿越。 */
export function parseRecordingKeyParts(group: string, line: string): { group: string; line: string } {
  const g = RECORDING_GROUP_SHAPE.exec(group)
  const l = RECORDING_LINE_SHAPE.exec(line)
  if (!g || !l) throw new Error(`非法的组/句号：${group}-${line}`)
  return { group: g[0], line: l[0] }
}

/** 完整录音键（Gxx-Lnn / Gxx-Tnn）：渲染端查表用；主进程写盘前经 parseRecordingKeyParts 白名单校验。 */
export function recordingKey(groupId: string, mode: 'lines' | 'free', no: number): string {
  return `${groupId}-${takeLineId(mode, no)}`
}

/**
 * 存完一条后该落到哪一句：从当前句往后找第一条没录的，到末尾再回绕到开头；
 * 全组都录过 = null（面板显示完成态、停在原地，不再跳）。
 * 候选里永远只有**没录过**的行，且排除当前句——所以自动前进绝不会落在已录行上，
 * 覆盖只可能来自手动点句号。录失败/没麦克风时调用方压根不该走到这里。
 */
export function nextUnrecordedLine(input: {
  lines: readonly number[]
  recorded: readonly number[]
  current: number
}): number | null {
  const done = new Set(input.recorded)
  const pending = input.lines.filter((no) => no !== input.current && !done.has(no))
  if (pending.length === 0) return null
  return pending.find((no) => no > input.current) ?? pending[0]
}
