import * as React from 'react'
import { summarizeAsrCheck, type AsrCheckItem, type AsrCheckState } from '@shared/train/asr-check'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Modal } from './modal'

/**
 * 全量识别比对（验收）：把每条录音喂给现役模型，和稿子原文比。
 *
 * 结果只在主进程内存里，关掉弹层就丢——重跑一次约一分钟，不值得落库。
 * 默认只列不一致：全对时不该让人翻 83 行去找「哪里错了」。
 */

function gradeText(grade: AsrCheckItem['grade']): string {
  if (grade === 'same') return '一致'
  return grade === 'near' ? '差一点' : '明显错'
}

function gradeClass(grade: AsrCheckItem['grade']): string {
  if (grade === 'same') return 'text-muted-foreground'
  return grade === 'near' ? 'text-amber-500' : 'text-red-400'
}

function elapsedSeconds(state: AsrCheckState | null): number {
  if (!state) return 0
  const end = state.running ? Date.now() : state.finishedAt
  if (!state.startedAt) return 0
  return Math.max(0, Math.round((end - state.startedAt) / 1000))
}

export function AsrCheckDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.ReactElement {
  const [state, setState] = React.useState<AsrCheckState | null>(null)
  const [showAll, setShowAll] = React.useState(false)

  React.useEffect(() => {
    if (!open) return
    setShowAll(false)
    void window.api.asrCheckStart().then(setState)
  }, [open])

  const running = state?.running ?? false
  React.useEffect(() => {
    if (!open || !running) return
    const timer = window.setInterval(() => {
      void window.api.asrCheckState().then(setState)
    }, 600)
    return () => window.clearInterval(timer)
  }, [open, running])

  const summary = summarizeAsrCheck(state?.items ?? [])
  const items = state?.items ?? []
  const visible = showAll ? items : items.filter((item) => item.grade !== 'same')

  return (
    <Modal
      open={open}
      title="全量识别比对"
      hint="用现役模型把每条录音跑一遍，和稿子原文比；标点与空白不参与比较。关掉就丢，重跑一次约一分钟。"
      onClose={onClose}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        {running ? (
          <>
            <div className="text-xs text-muted-foreground">
              已完成 {state?.done ?? 0} / {state?.total ?? 0}
              {state?.current ? ` · 正在跑 ${state.current}` : ''}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void window.api.asrCheckStop().then(setState)}
            >
              停止
            </Button>
          </>
        ) : (
          <>
            <div className="text-xs text-muted-foreground">
              {state?.error
                ? `识别中断：${state.error}`
                : `共 ${summary.total} 条 · 一致 ${summary.same} · 差一点 ${summary.near} · 明显错 ${summary.wrong} · ${elapsedSeconds(state)} 秒`}
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setShowAll((value) => !value)}>
                {showAll ? '只看不一致' : '显示全部'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void window.api.asrCheckStart().then(setState)}>
                重新识别
              </Button>
            </div>
          </>
        )}
      </div>

      {!running && summary.total > 0 && summary.same === summary.total ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">全部一致</p>
      ) : null}

      {!running && !state?.error && summary.total === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">账本里还没有带标签的录音</p>
      ) : null}

      <ul className="divide-y divide-border/40">
        {visible.map((item) => (
          <li key={item.key} className="px-4 py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-xs text-muted-foreground">{item.key}</span>
              <span className={cn('text-xs', gradeClass(item.grade))}>
                {gradeText(item.grade)}
                {item.grade === 'near' ? `（差 ${item.distance} 字）` : ''}
              </span>
            </div>
            <p className="mt-1 text-xs leading-relaxed">{item.expected}</p>
            <p className={cn('text-xs leading-relaxed', gradeClass(item.grade))}>{item.actual || '（空）'}</p>
          </li>
        ))}
      </ul>

      {running && items.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">正在加载识别模型…</p>
      ) : null}
    </Modal>
  )
}
