import * as React from 'react'
import type { TrainRunRecord } from '@shared/train/run'
import { runStatusLabel } from '@shared/train/run'
import { Row, StatusPill } from './primitives'
import { runHint, runTone, runTitle } from '../run-format'

/** 一条训练记录：标题是「种类 · 实验」，说明是数据/步数/损失/耗时。 */
export function RunRow({
  run,
  action
}: {
  run: TrainRunRecord
  action?: React.ReactNode
}): React.ReactElement {
  return (
    <Row label={runTitle(run)} hint={runHint(run)}>
      <StatusPill tone={runTone(run.status)}>{runStatusLabel(run.status)}</StatusPill>
      {action}
    </Row>
  )
}

/**
 * 损失曲线：纯 SVG，不用图表库——一条折线不值得多一个依赖，也不该带自己的色板。
 * 只有一个点时不画（一个点说明不了趋势）。
 */
export function Sparkline({ run }: { run: TrainRunRecord }): React.ReactElement | null {
  const points = (run.metrics?.series ?? [])
    .map((point) => point.loss)
    .filter((loss): loss is number => typeof loss === 'number')
  if (points.length < 2) return null
  const min = Math.min(...points)
  const max = Math.max(...points)
  const span = max - min || 1
  const polyline = points
    .map((loss, index) => `${(index / (points.length - 1)) * 100},${100 - ((loss - min) / span) * 100}`)
    .join(' ')
  return (
    <div className="px-4 py-3">
      <svg viewBox="0 0 100 100" preserveAspectRatio="none" className="h-16 w-full text-primary" aria-hidden>
        <polyline
          points={polyline}
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      </svg>
      <p className="mt-1 text-xs text-muted-foreground">
        最低 {min.toFixed(4)} · 最新 {points[points.length - 1].toFixed(4)} · {points.length} 点
      </p>
    </div>
  )
}
