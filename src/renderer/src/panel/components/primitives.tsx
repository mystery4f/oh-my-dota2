import * as React from 'react'
import { cn } from '@/lib/utils'

/**
 * 面板 v2 的四种积木。设置行只允许由它们拼出来：
 * 排版刻度写在组件里，调用方拿不到裸 class，全站就不会漂。
 */

/** 一页的外框：标题 + 一句话说明 + 内容。 */
export function Section({
  title,
  hint,
  children
}: {
  title: string
  hint?: string
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-[15px] font-medium tracking-tight">{title}</h1>
        {hint ? <p className="mt-1 text-xs text-muted-foreground">{hint}</p> : null}
      </div>
      {children}
    </div>
  )
}

/** 卡片：单层描边，不用阴影——深色底上看不见阴影。 */
export function Panel({
  children,
  className
}: {
  children: React.ReactNode
  className?: string
}): React.ReactElement {
  return (
    <div className={cn('rounded-lg border border-border/70 bg-card', className)}>{children}</div>
  )
}

/** 组标题：卡片里的一小节，带一条分隔线。 */
export function Group({
  label,
  action,
  children
}: {
  label: string
  action?: React.ReactNode
  children: React.ReactNode
}): React.ReactElement {
  return (
    <div className="border-t border-border/60 first:border-t-0">
      <div className="flex min-h-9 items-center justify-between px-4">
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        {action}
      </div>
      <div className="divide-y divide-border/40">{children}</div>
    </div>
  )
}

/**
 * 一行设置：左边标签（可带一句说明），右边控件。
 * stacked 用于控件比标签宽的行（滑块、模板输入），此时控件另起一行占满。
 */
export function Row({
  label,
  hint,
  htmlFor,
  stacked,
  children
}: {
  label: string
  hint?: string
  htmlFor?: string
  stacked?: boolean
  children?: React.ReactNode
}): React.ReactElement {
  const Label = htmlFor ? 'label' : 'span'
  const name = (
    <>
      <Label htmlFor={htmlFor} className="text-sm">
        {label}
      </Label>
      {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
    </>
  )

  if (stacked)
    return (
      <div className="px-4 py-3">
        <div>{name}</div>
        <div className="mt-2">{children}</div>
      </div>
    )

  return (
    <div className="flex min-h-11 items-center justify-between gap-4 px-4 py-2">
      <div className="min-w-0">{name}</div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  )
}

const PILL_TONES = {
  ready: 'border-emerald-500/40 text-emerald-300',
  warn: 'border-amber-500/40 text-amber-300',
  bad: 'border-destructive/50 text-destructive',
  idle: 'border-border text-muted-foreground'
} as const

export type PillTone = keyof typeof PILL_TONES

/** 只给「会变化的状态」用胶囊；静态标签一律纯文本。 */
export function StatusPill({
  tone = 'idle',
  children
}: {
  tone?: PillTone
  children: React.ReactNode
}): React.ReactElement {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap',
        PILL_TONES[tone]
      )}
    >
      {children}
    </span>
  )
}
