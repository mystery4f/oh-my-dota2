import type { TrainTaskInfo } from '@shared/train/task'
import { progressText } from '@shared/train/preflight'
import { Button } from '@/components/ui/button'
import { formatDuration } from '../run-format'
import { Row, StatusPill } from './primitives'

/**
 * 运行段的任务行：两个训练页共用。
 * 文案、颜色、停止键只该有一份——它们描述的是同一件事，两处各写一遍就会各说各话。
 */
export function TrainTaskRow({
  task,
  running,
  flush,
  label = '当前任务',
  now
}: {
  task: TrainTaskInfo | null
  running: boolean
  flush?: boolean
  /** 行标题（#184）：表述归这个组件，标题归调用方——音色训练页要的是「训练中」。 */
  label?: string
  /**
   * 由调用方驱动的「现在」（#184）：音色页在任务运行期间挂着 5 秒定时器，
   * 传进来这一行才会跟着走；识别训练页不传，用渲染那一刻的时间。
   */
  now?: number
}): React.ReactElement {
  return (
    <Row
      flush={flush}
      label={task ? `${label} · ${task.kind}` : label}
      hint={
        task
          ? `${task.stage || '准备中'}｜${formatDuration((task.endedAt ?? now ?? Date.now()) - task.startedAt)}`
          : '没有正在跑的训练'
      }
    >
      {task ? (
        <>
          <StatusPill tone={task.status === 'failed' ? 'bad' : running ? 'warn' : 'ready'}>
            {/* #184：progress = -1 是「这版脚本不报进度」，印成 -1% 就是假话。 */}
            {task.status === 'running' ? progressText(task.progress) : task.status}
          </StatusPill>
          <Button size="sm" variant="outline" disabled={!running} onClick={() => void window.api.trainStop()}>
            停止
          </Button>
        </>
      ) : null}
    </Row>
  )
}
