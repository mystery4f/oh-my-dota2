import * as React from 'react'
import { Sidebar } from './components/sidebar'
import { Panel, Section } from './components/primitives'
import { DEFAULT_SECTION, isSectionId, SECTIONS, type SectionId } from './sections'

/**
 * 面板 v2 的壳：标题栏 + 侧边栏 + 内容区。
 * M1 阶段各页还是占位，M2–M4 逐页迁进来；默认入口仍是旧 App，
 * 加 `?panel=v2` 才用这套（迁移期间两套并存，随时能对照）。
 */

/** 每页由哪个里程碑迁入，占位页直接把这句话显示出来，免得看的人以为坏了。 */
const MIGRATES_IN: Record<SectionId, string> = {
  overview: 'M4',
  engine: 'M2',
  talk: 'M4',
  chatout: 'M4',
  read: 'M3',
  overlay: 'M3',
  hotkeys: 'M2',
  about: 'M2'
}

export function PanelApp(): React.ReactElement {
  const [active, setActive] = React.useState<SectionId>(() => {
    const fromUrl = new URLSearchParams(window.location.search).get('s')
    return isSectionId(fromUrl) ? fromUrl : DEFAULT_SECTION
  })

  const select = (id: SectionId): void => {
    setActive(id)
    const url = new URL(window.location.href)
    url.searchParams.set('s', id)
    window.history.replaceState(null, '', url)
  }

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k') return
      e.preventDefault()
      // 搜索在 M2 建索引后接上；先别让 Ctrl+K 落空到浏览器默认行为。
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const meta = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0]

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* 标题栏固定、内容区自己滚：输入框不许滚进 drag 带子里，否则点了没反应 */}
      <header className="app-drag flex h-[38px] shrink-0 items-center justify-between border-b border-border/60 bg-background pr-32">
        <div className="flex items-center gap-2 pl-3 text-[13px] font-medium tracking-tight">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          oh-my-dota2
          <span className="font-normal text-muted-foreground">· 面板 v2</span>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <Sidebar active={active} onSelect={select} />

        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[720px] px-6 pb-16 pt-6">
            <Section title={meta.title} hint={meta.hint}>
              <Panel>
                <div className="px-4 py-6 text-center">
                  <p className="text-sm text-muted-foreground">这一页在 {MIGRATES_IN[meta.id]} 迁入</p>
                  <p className="mt-1 text-xs text-muted-foreground/70">
                    当前只是壳，设置项还没接过来，旧面板不受影响
                  </p>
                </div>
              </Panel>
            </Section>
          </div>
        </main>
      </div>
    </div>
  )
}
