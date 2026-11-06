import * as React from 'react'
import { createPortal } from 'react-dom'
import { cn } from '@/lib/utils'

/**
 * 面板唯一的弹窗。用来装「比一行设置大、又不该占一整页」的东西：
 * 音色包这类需要列表 + 下载 + 删除 + 服务的块。
 *
 * 三条规矩：Esc 和点遮罩都关；开着时锁住 body 滚动（背后的内容别跟着跑）；
 * 内容超出时只有中段滚，标题和关闭键永远看得见。
 */
export function Modal({
  open,
  title,
  hint,
  onClose,
  children
}: {
  open: boolean
  title: string
  hint?: string
  onClose: () => void
  children: React.ReactNode
}): React.ReactElement | null {
  React.useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      e.stopPropagation()
      onClose()
    }
    window.addEventListener('keydown', onKey)
    const previous = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    return () => {
      window.removeEventListener('keydown', onKey)
      document.body.style.overflow = previous
    }
  }, [open, onClose])

  if (!open) return null

  return createPortal(
    <div
      className="app-no-drag fixed inset-0 z-50 flex items-start justify-center bg-black/60 pt-14"
      onClick={onClose}
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className="flex max-h-[78vh] w-[min(780px,92vw)] flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-start justify-between gap-4 border-b border-border/70 px-4 py-3">
          <div>
            <div className="text-sm font-medium">{title}</div>
            {hint ? <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p> : null}
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭"
            className={cn(
              'rounded p-1 text-muted-foreground transition-colors',
              'hover:bg-muted/50 hover:text-foreground'
            )}
          >
            ✕
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </div>
    </div>,
    document.body
  )
}
