import * as React from 'react'
import { cn } from '@/lib/utils'
import { readCollapseOpen, subscribeCollapse, writeCollapseOpen } from '../collapse'
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
  flush,
  children
}: {
  label: string
  hint?: string
  htmlFor?: string
  stacked?: boolean
  flush?: boolean
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
      <div className={cn('py-3', !flush && 'px-4')}>
        <div>{name}</div>
        <div className="mt-2">{children}</div>
      </div>
    )

  return (
    <div className={cn('flex min-h-11 items-center justify-between gap-4 py-2', !flush && 'px-4')}>
      <div className="min-w-0 flex-1">{name}</div>
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

/**
 * 即时保存的微反馈：成功闪「已保存」1.2 秒，失败常驻红字。
 * 放在触发行里，和控件并排；打字类的输入框不挂它（每键一闪太吵）。
 */
export function SaveFlash({
  flash,
  error
}: {
  flash: string
  error: string
}): React.ReactElement | null {
  if (error) return <span className="text-[11px] text-destructive">{error}</span>
  if (flash) return <span className="text-[11px] text-emerald-400">{flash}</span>
  return null
}


/**
 * 折叠组：默认收起，展开状态记在 localStorage——重新打开面板不用再点一遍。
 * 语义是「低频的高级项」，不是「隐藏问题」：里面必须有行有说明。
 */
export function CollapsibleGroup({
  id,
  label,
  defaultOpen = false,
  action,
  children
}: {
  id: string
  label: string
  defaultOpen?: boolean
  action?: React.ReactNode
  children: React.ReactNode
}): React.ReactElement {
  // 展开状态活在 collapse.ts 里：搜索命中时它会从外部把组翻开，并通知这里重渲染。
  const open = React.useSyncExternalStore(subscribeCollapse, () => readCollapseOpen(id, defaultOpen))
  const toggle = (): void => {
    writeCollapseOpen(id, !open)
  }
  return (
    <div className="border-t border-border/60 first:border-t-0">
      <button
        type="button"
        onClick={toggle}
        className="flex min-h-9 w-full items-center justify-between px-4 text-left"
        aria-expanded={open}
      >
        <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
          {label}
        </span>
        <span className="flex items-center gap-2">
          {action}
          <span className="text-[10px] text-muted-foreground">{open ? '收起 ▲' : '展开 ▼'}</span>
        </span>
      </button>
      {open ? <div className="divide-y divide-border/40">{children}</div> : null}
    </div>
  )
}
