import * as React from 'react'
import { cn } from '@/lib/utils'
import { SECTION_GROUPS, SECTIONS, type SectionId } from '../sections'

/**
 * 侧边栏是唯一导航：分组 + 一格 32px 的行，选中态靠左侧亮条，不再靠底色块。
 * badges 按分区 id 传一个角标（热键冲突数、更新可装等），没有就不占位。
 */
export function Sidebar({
  active,
  onSelect,
  badges
}: {
  active: SectionId
  onSelect: (id: SectionId) => void
  badges?: Partial<Record<SectionId, React.ReactNode>>
}): React.ReactElement {
  const byId = new Map(SECTIONS.map((s) => [s.id, s]))

  const item = (id: SectionId): React.ReactElement => {
    const section = byId.get(id)
    if (!section) return <></>
    const on = id === active
    return (
      <button
        key={id}
        type="button"
        onClick={() => onSelect(id)}
        aria-current={on ? 'page' : undefined}
        className={cn(
          'relative flex h-8 w-full items-center gap-2 rounded-md pl-3 pr-2 text-left text-[13px] transition-colors',
          on
            ? 'bg-accent/10 text-foreground'
            : 'text-muted-foreground hover:bg-white/[0.03] hover:text-foreground'
        )}
      >
        {on ? (
          <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
        ) : null}
        <span className="truncate">{section.title}</span>
        {badges?.[id] ? <span className="ml-auto shrink-0">{badges[id]}</span> : null}
      </button>
    )
  }

  return (
    <aside className="flex w-52 shrink-0 flex-col border-r border-border/60">
      <nav className="flex-1 space-y-1 overflow-y-auto p-2">
        {item('overview')}
        {SECTION_GROUPS.map((group) => (
          <div key={group.label} className="pt-3">
            <div className="px-3 pb-1 text-[10px] uppercase tracking-wider text-muted-foreground/70">
              {group.label}
            </div>
            <div className="space-y-0.5">{group.ids.map((id) => item(id))}</div>
          </div>
        ))}
      </nav>
      <div className="space-y-0.5 border-t border-border/60 p-2">{item('about')}</div>
    </aside>
  )
}
