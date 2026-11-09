import { runKindLabel, runElapsedMs, type TrainRunRecord } from '@shared/train/run'
import type { PillTone } from './components/primitives'

const RUN_TONES: Record<TrainRunRecord['status'], PillTone> = {
  running: 'warn',
  trained: 'ready',
  applied: 'ready',
  failed: 'bad',
  stopped: 'idle'
}

/**
 * 训练记录的排版规则：状态色、时长、一行摘要。
 * 与组件分文件，只是因为 react-refresh 要求「只导出组件的文件」才能热替换。
 */
export function runTone(status: TrainRunRecord['status']): PillTone {
  return RUN_TONES[status]
}

export function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))}s`
  const minutes = Math.floor(ms / 60_000)
  if (minutes < 60) return `${minutes}m`
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`
}

/** 一行能看完的摘要：数据量、步数、损失、耗时。 */
/**
 * 记录是快照，不会随新的一轮成功而改口：一小时的失败和刚刚的失败长得一模一样，
 * 所以摘要第一段必须是发生时间（当天只给时分，隔天补日期）。
 */
export function runStamp(run: TrainRunRecord): string {
  const at = new Date(run.startedAt)
  const now = new Date()
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  const sameDay =
    at.getFullYear() === now.getFullYear() && at.getMonth() === now.getMonth() && at.getDate() === now.getDate()
  return sameDay ? hhmm : `${String(at.getMonth() + 1).padStart(2, '0')}-${String(at.getDate()).padStart(2, '0')} ${hhmm}`
}

export function runHint(run: TrainRunRecord): string {
  const parts: string[] = [runStamp(run)]
  // ASR 微调的一行摘要先说开训口径：与面板上「增量微调 / 全量重训」两个按钮同名，扫历史时对得上。
  if (run.kind === 'asr-ft' && run.params.mode) {
    parts.push(run.params.mode === 'incremental' ? '增量微调' : '全量重训')
  }
  if (run.data.files > 0) parts.push(`${run.data.files} 条`)
  if (run.metrics) {
    if (run.metrics.steps > 0) parts.push(`${run.metrics.steps} steps`)
    if (run.metrics.lastLoss !== null) parts.push(`loss ${run.metrics.lastLoss.toFixed(4)}`)
  }
  parts.push(formatDuration(runElapsedMs(run)))
  if (run.error) parts.push(run.error)
  return parts.join(' · ')
}

export function runTitle(run: TrainRunRecord): string {
  return `${runKindLabel(run.kind)} · ${run.experiment}`
}
