import * as React from 'react'
import { SECTION_GROUPS } from '../sections'
import { searchSections, type SearchHit } from '../search-index'

/**
 * Ctrl+K 搜索浮层：输入即筛，回车跳转。
 * 匹配逻辑只有 searchSections 一份，这里只管键盘和排版。
 */

export function SearchPalette({
  onClose,
  onPick
}: {
  onClose: () => void
  onPick: (hit: SearchHit) => void
}): React.ReactElement {
  const [query, setQuery] = React.useState('')
  const [index, setIndex] = React.useState(0)

  const hits = React.useMemo(() => searchSections(query).slice(0, 8), [query])

  React.useEffect(() => {
    setIndex(0)
  }, [query])

  const pick = (hit: SearchHit): void => {
    onPick(hit)
    onClose()
  }

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      onClose()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      setIndex((i) => Math.min(i + 1, hits.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const hit = hits[index]
      if (hit) pick(hit)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center bg-black/50 pt-[12vh]" onClick={onClose}>
      <div
        className="w-[420px] overflow-hidden rounded-lg border border-border bg-background shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="搜设置：api key / 热键 / 缓存…"
          className="w-full border-b border-border bg-transparent px-4 py-3 text-sm outline-none placeholder:text-muted-foreground/60"
        />
        <ul className="max-h-80 overflow-y-auto py-1">
          {hits.length === 0 ? (
            <li className="px-4 py-3 text-sm text-muted-foreground">
              {query.trim() ? '没有匹配的分区' : '输入关键词：热键 / 缓存 / 语速 / 音色包'}
            </li>
          ) : (
            hits.map((hit, i) => {
              const group = SECTION_GROUPS.find((g) => g.ids.includes(hit.id))?.label ?? ''
              return (
                <li key={hit.id}>
                  <button
                    type="button"
                    className={`flex w-full items-baseline gap-3 px-4 py-2 text-left text-sm ${
                      i === index ? 'bg-accent/15 text-foreground' : 'text-foreground/80'
                    }`}
                    onMouseEnter={() => setIndex(i)}
                    onClick={() => pick(hit)}
                  >
                    <span className="font-medium">{hit.title}</span>
                    <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">
                      {hit.hint}
                      {query.trim() ? ` · 命中「${hit.matched}」` : ''}
                    </span>
                    {group ? (
                      <span className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground/70">
                        {group}
                      </span>
                    ) : null}
                  </button>
                </li>
              )
            })
          )}
        </ul>
        <p className="border-t border-border px-4 py-2 text-[11px] text-muted-foreground/70">
          ↑↓ 选择 · 回车跳转 · Esc 关闭
        </p>
      </div>
    </div>
  )
}
