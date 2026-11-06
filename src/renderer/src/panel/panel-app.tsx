import * as React from 'react'
import { Sidebar } from './components/sidebar'
import { Section } from './components/primitives'
import { openCollapseGroup } from './collapse'
import { SearchPalette } from './components/search'
import { VoicePackDialog } from './components/voice-pack-dialog'
import { DEFAULT_SECTION, isSectionId, SECTIONS, type SectionId } from './sections'
import { EnginePage } from './pages/engine'
import { HotkeysPage } from './pages/hotkeys'
import { AboutPage } from './pages/about'
import { ReadPage } from './pages/read'
import { OverlayPage } from './pages/overlay'
import { TalkPage } from './pages/talk'
import { ChatoutPage } from './pages/chatout'
import { OverviewPage } from './pages/overview'


/**
 * 面板的壳：标题栏 + 侧边栏 + 内容区。八个分区之间的导航只有侧边栏，
 * 不再有 tab；`?s=<分区>` 才能直达某一页（开发时用 OMD2_QUERY 注入）。
 */
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

  const [searchOpen, setSearchOpen] = React.useState(false)
  // 音色包弹窗由壳持有：朗读页和声出页各给一个按钮，打开的永远是同一个弹窗。
  const [packsOpen, setPacksOpen] = React.useState(false)

  React.useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (!(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'k') return
      e.preventDefault()
      setSearchOpen((open) => !open)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const meta = SECTIONS.find((s) => s.id === active) ?? SECTIONS[0]

  const renderPage = (): React.ReactElement => {
    switch (active) {
      case 'engine':
        return <EnginePage />
      case 'hotkeys':
        return <HotkeysPage />
      case 'about':
        return <AboutPage />
      case 'read':
        return <ReadPage onOpenVoicePacks={() => setPacksOpen(true)} />
      case 'overlay':
        return <OverlayPage />
      case 'overview':
        return <OverviewPage />
      case 'talk':
        return <TalkPage onOpenVoicePacks={() => setPacksOpen(true)} />
      case 'chatout':
        return <ChatoutPage />
      default: {
        // 加了分区却忘了接线：编译期就报，别让人对着空白页猜。
        const unhandled: never = active
        throw new Error(`未接线的分区：${String(unhandled)}`)
      }
    }
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden">
      {/* 标题栏固定、内容区自己滚：输入框不许滚进 drag 带子里，否则点了没反应 */}
      <header className="app-drag flex h-[38px] shrink-0 items-center justify-between border-b border-border/60 bg-background pr-32">
        <div className="flex items-center gap-2 pl-3 text-[13px] font-medium tracking-tight">
          <span className="h-1.5 w-1.5 rounded-full bg-primary" />
          oh-my-dota2
          <span className="font-normal text-muted-foreground">· 面板 v2</span>
          <button
            type="button"
            className="app-no-drag ml-2 rounded border border-border/70 px-2 py-0.5 text-[11px] font-normal text-muted-foreground hover:text-foreground"
            onClick={() => setSearchOpen(true)}
            title="搜索设置项（Ctrl+K）"
          >
            搜索 · Ctrl+K
          </button>
        </div>
      </header>

      {searchOpen ? (
        <SearchPalette
          onClose={() => setSearchOpen(false)}
          onPick={(hit) => {
            if (hit.group) openCollapseGroup(hit.group)
            select(hit.id)
          }}
        />
      ) : null}

      <div className="flex min-h-0 flex-1">
        <Sidebar active={active} onSelect={select} />

        <main className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-[720px] px-6 pb-16 pt-6">
            <Section title={meta.title} hint={meta.hint}>
              {renderPage()}
            </Section>
          </div>
        </main>
      </div>

      <VoicePackDialog open={packsOpen} onClose={() => setPacksOpen(false)} />
    </div>
  )
}
