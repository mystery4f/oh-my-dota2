import * as React from 'react'
import { cn } from '@/lib/utils'
import { variantUrl, type VariantKey } from './mock'

const ORDER: VariantKey[] = ['D', 'A', 'B', 'C']

const LABELS: Record<VariantKey, string> = {
  A: '体检台',
  B: '链路工作台',
  C: '对话现场',
  D: '对讲机'
}

function go(next: VariantKey, broken: boolean): void {
  window.location.assign(variantUrl(next, broken))
}

/**
 * 原型切换条：只在 `?variant=` 出现时挂载，正式实现时整个目录删掉。
 * ← / → 循环切换，四个字以上不带焦点在输入框里才响应。
 */
export function PrototypeSwitcher({
  variant,
  broken
}: {
  variant: VariantKey
  broken: boolean
}): React.ReactElement {
  const idx = ORDER.indexOf(variant)

  const step = React.useCallback(
    (delta: number) => {
      const next = ORDER[(idx + delta + ORDER.length) % ORDER.length]
      go(next, broken)
    },
    [idx, broken]
  )

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const el = document.activeElement
      const typing =
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        (el instanceof HTMLElement && el.isContentEditable)
      if (typing) return
      if (e.key === 'ArrowLeft') step(-1)
      if (e.key === 'ArrowRight') step(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [step])

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex justify-center">
      <div className="pointer-events-auto flex items-center gap-1 rounded-full border border-border bg-background/95 px-1.5 py-1 shadow-lg backdrop-blur">
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => step(-1)}
          title="上一个方案（←）"
        >
          ←
        </button>
        <span className="px-1 text-xs">
          <span className="font-mono text-foreground">{variant}</span>
          <span className="ml-1.5 text-muted-foreground">{LABELS[variant]}</span>
        </span>
        <button
          type="button"
          className="flex h-7 w-7 items-center justify-center rounded-full text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={() => step(1)}
          title="下一个方案（→）"
        >
          →
        </button>
        <span className="mx-1 h-4 w-px bg-border" />
        <button
          type="button"
          className={cn(
            'rounded-full px-2 py-1 text-[11px]',
            broken ? 'bg-destructive/15 text-destructive' : 'text-muted-foreground hover:bg-muted'
          )}
          onClick={() => go(variant, !broken)}
          title="把链路掰成断的，看断链状态长什么样"
        >
          {broken ? '断链中' : '看断链'}
        </button>
      </div>
    </div>
  )
}
