import type { TrainTaskInfo } from '@shared/train/task'
import { Button } from '@/components/ui/button'
import { formatDuration } from '../run-format'
import { Row, StatusPill } from './primitives'

/**
 * 运行段的任务行：两个训练页共用。
 * 文案、颜色、停止键只该有一份——它们描述的是同一件事，两处各写一遍就会各说各话。
 */
export function TrainTaskRow({ task, running }: { task: TrainTaskInfo | null; running: boolean }): React.ReactElement {
  return (
    <Row
      label={task ? `当前任务 · ${task.kind}` : '当前任务'}
      hint={
        task
          ? `${task.stage || '准备中'}｜${formatDuration((task.endedAt ?? Date.now()) - task.startedAt)}`
          : '没有正在跑的训练'
      }
    >
      {task ? (
        <>
          <StatusPill tone={task.status === 'failed' ? 'bad' : running ? 'warn' : 'ready'}>
            {task.status === 'running' ? `${task.progress}%` : task.status}
          </StatusPill>
          <Button size="sm" variant="outline" disabled={!running} onClick={() => void window.api.trainStop()}>
            停止
          </Button>
        </>
      ) : null}
    </Row>
  )
}
