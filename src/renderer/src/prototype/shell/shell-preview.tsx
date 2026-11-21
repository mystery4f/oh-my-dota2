/**
 * 整壳原型：左侧一条竖导航，右侧十二页。
 *
 * 这一版对接真面板的十页（总览 / 说话 / 听话 / 浮层 / 直发 / 翻译引擎 / 音色训练 / 识别训练 / 热键 / 关于）加两页原型自定的（音色包 /
 * 这台机器的接线），每页都按真面板的四到六组内容铺满，能点的都点得动（假数据、真状态）。
 *
 * 两块常驻的写法是刻意的：导航只有一列（十个一级入口已经是上限），页面标题下面永远有一句「这一页回答什么问题」。
 */
import * as React from 'react'

import { AboutPage } from './pages/about'
import { AsrPage } from './pages/asr'
import { ChatoutPage } from './pages/chatout'
import { EnginePage } from './pages/engine'
import { HotkeysPage } from './pages/hotkeys'
import { OverlayPage } from './pages/overlay'
import { OverviewPage } from './pages/overview'
import { ReadPage } from './pages/read'
import { TalkPage } from './pages/talk'
import { BarePage } from './pages/bare'
import { BoardPage } from './pages/board'
import { HelmPage } from './pages/helm'
import { PacksPage } from './pages/packs'
import { VoicePage } from './pages/voice'
import { WirePage } from './pages/wire'
import { ALL, MATCH, NOW, SYS, STUDIO, type Screen, isScreen } from './nav'
import { C, FS, SP } from './tokens'

const buildPages = (
  go: (next: Screen) => void
): Record<Screen, { title: string; note: string; render: () => React.ReactElement }> => ({
  helm: {
    title: '这一局',
    note: '现在该做什么；三个动作永远在同一位置。',
    render: () => <HelmPage />
  },
  bare: {
    title: '无窗口形态',
    note: '产品默认没有主界面：一条浮层 + 三个热键，其余它自己做。',
    render: () => <BarePage />
  },
  board: {
    title: '副屏',
    note: '第二块屏上一条 320 宽，与浮层同一份快照。',
    render: () => <BoardPage />
  },
  overview: {
    title: '总览',
    note: '现在能不能开局；不能的话卡在哪一环。',
    render: () => <OverviewPage />
  },
  talk: {
    title: '说话',
    note: '按住说中文 → 认成字 → 翻成英文 → 念给队友听。',
    render: () => <TalkPage />
  },
  read: {
    title: '听话',
    note: '别人打的字念出来。和说话是两条独立的腿。',
    render: () => <ReadPage />
  },
  overlay: { title: '浮层', note: '屏幕上那一层长什么样、放哪里。', render: () => <OverlayPage /> },
  chatout: {
    title: '直发',
    note: '把中文送进聊天框（先翻译），不念出来。',
    render: () => <ChatoutPage />
  },
  engine: {
    title: '翻译引擎',
    note: '谁在翻、翻成什么样、翻错了能查到哪一条。',
    render: () => <EnginePage />
  },
  voice: { title: '音色训练', note: '数据 → 运行 → 产物，三块。', render: () => <VoicePage /> },
  packs: {
    title: '音色包',
    note: '一个包＝参考音频＋它自己的权重；朗读和声出共用。',
    render: () => <PacksPage go={go} />
  },
  asr: { title: '识别训练', note: '环境 / 数据 / 训练 / 现役，四步。', render: () => <AsrPage /> },
  hotkeys: {
    title: '热键',
    note: '七条动作键位；撞键就整表拒绝保存。',
    render: () => <HotkeysPage />
  },
  about: {
    title: '关于',
    note: '版本、诊断、文档：出问题该把什么交出去。',
    render: () => <AboutPage />
  },
  wire: {
    title: '这台机器的接线',
    note: '七段，一段一条腿；最后一段是「这些线还好吗」。',
    render: () => <WirePage />
  }
})

function readScreen(): Screen {
  const q = new URLSearchParams(window.location.search)
  for (const key of ['screen', 's']) {
    const raw = q.get(key)
    if (isScreen(raw)) return raw
  }
  return 'helm'
}

export function ShellPreview(): React.ReactElement {
  const [screen, setScreen] = React.useState<Screen>(readScreen)

  React.useEffect(() => {
    const id = `?screen=${screen}`
    if (window.location.search !== id) window.history.replaceState(null, '', id)
  }, [screen])

  const item = (id: Screen): React.ReactElement | null => {
    const found = ALL.find((n) => n.id === id)
    if (!found) return null
    const on = screen === id
    return (
      <button
        key={id}
        type="button"
        onClick={() => setScreen(id)}
        style={{
          display: 'flex',
          alignItems: 'baseline',
          gap: 8,
          width: '100%',
          textAlign: 'left',
          background: on ? `${C.accent}12` : 'transparent',
          border: 'none',
          borderLeft: `2px solid ${on ? C.accent : 'transparent'}`,
          color: on ? C.accent : C.text,
          padding: '7px 10px',
          fontSize: FS.body,
          cursor: 'pointer'
        }}
      >
        <span style={{ flex: '1 1 auto', minWidth: 0 }}>{found.label}</span>
        {found.badge ? (
          <span
            style={{
              flex: '0 0 auto',
              fontSize: FS.mini,
              color: found.tone === 'bad' ? C.danger : found.tone === 'ok' ? C.accent : C.warn
            }}
          >
            {found.badge}
          </span>
        ) : (
          <span style={{ flex: '0 0 auto', fontSize: FS.mini, color: C.dim, whiteSpace: 'nowrap' }}>
            {found.note}
          </span>
        )}
      </button>
    )
  }

  const PAGES = React.useMemo(() => buildPages(setScreen), [])
  const page = PAGES[screen]

  return (
    <div
      style={{
        display: 'flex',
        height: '100vh',
        background: C.bg,
        color: C.text,
        fontFamily: 'inherit'
      }}
    >
      <aside
        style={{
          flex: '0 0 218px',
          borderRight: `1px solid ${C.line}`,
          background: C.rail,
          display: 'flex',
          flexDirection: 'column',
          minHeight: 0
        }}
      >
        <div style={{ padding: '14px 12px 10px', display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ width: 7, height: 7, borderRadius: 999, background: C.accent }} />
          <span style={{ fontSize: FS.body, fontWeight: 600 }}>oh-my-dota2</span>
        </div>
        <div style={{ overflow: 'auto', flex: '1 1 auto', minHeight: 0 }}>
          {NOW.map((n) => item(n.id))}
          <div
            style={{
              padding: '12px 10px 4px',
              fontSize: FS.mini,
              color: C.dim,
              letterSpacing: 0.6
            }}
          >
            对局里
          </div>
          {MATCH.map((n) => item(n.id))}
          <div
            style={{
              padding: '12px 10px 4px',
              fontSize: FS.mini,
              color: C.dim,
              letterSpacing: 0.6
            }}
          >
            平时
          </div>
          {STUDIO.map((n) => item(n.id))}
          <div
            style={{
              padding: '12px 10px 4px',
              fontSize: FS.mini,
              color: C.dim,
              letterSpacing: 0.6
            }}
          >
            系统
          </div>
          {SYS.map((n) => item(n.id))}
        </div>
        <div
          style={{ padding: 10, borderTop: `1px solid ${C.line}`, fontSize: FS.mini, color: C.dim }}
        >
          <div>v1.2.0 · 原型</div>
          <div style={{ marginTop: 2 }}>十三屏 · 60 个设置 · 7 条热键</div>
        </div>
      </aside>

      <main style={{ flex: '1 1 auto', minWidth: 0, display: 'flex', flexDirection: 'column' }}>
        <header style={{ padding: '14px 22px 10px', borderBottom: `1px solid ${C.line}` }}>
          <div style={{ fontSize: 17, fontWeight: 650 }}>{page.title}</div>
          <div style={{ fontSize: FS.small, color: C.dim, marginTop: 3 }}>{page.note}</div>
        </header>
        <div style={{ flex: '1 1 auto', overflow: 'auto', padding: `18px ${SP.page}px 40px` }}>
          <div style={{ maxWidth: 780, margin: '0 auto' }}>{page.render()}</div>
        </div>
      </main>
    </div>
  )
}

export const SHELL_SCREENS: Screen[] = ALL.map((n) => n.id)
