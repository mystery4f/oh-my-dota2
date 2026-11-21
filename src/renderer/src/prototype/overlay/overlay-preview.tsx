import * as React from 'react'

/**
 * 浮层本体原型（一次性，选完即删）：开 `/src/prototype/preview.html?overlay=1`。
 *
 * 面板里的「浮层」那一页只管设置；这里画的是**贴在游戏上的那一层**，四个形态：
 *   展开 · 未锁定（工具条 + 行 + 拖拽边）
 *   展开 · 已锁定（只剩行，鼠标穿过去）
 *   收起 · 132×34 小图标（带未读角标）
 *   呼出面板 Alt+Shift+H（历史 / 短语 / AI 建议 / 看一眼）
 *
 * 配色跟整壳方案同一套：近黑半透明 + 磷光青绿，青绿只表示「通 / 已播」。
 */

const C = {
  bg: '#07090c',
  line: 'rgba(255,255,255,0.09)',
  text: '#e8eef4',
  dim: '#7d8894',
  accent: '#2fe6a8',
  warn: '#f0b429',
  card: '#0d1218'
}

const ROWS = [
  {
    hero: '#c23b22',
    orig: '[All] Shadow Fiend: gg push bot',
    trans: '推下路',
    spoken: '已播',
    tone: 'ok'
  },
  {
    hero: '#2f8fd6',
    orig: '[All] Lina: bkb on their carry',
    trans: '他们主 C 有 BKB',
    spoken: '已播',
    tone: 'ok'
  },
  {
    hero: '#7a5cd6',
    orig: '[Team] CM: wards are out',
    trans: '眼没了',
    spoken: '没播出去',
    tone: 'warn'
  }
]

function GameCanvas({
  children,
  label,
  height = 300
}: {
  children: React.ReactNode
  label: string
  height?: number
}): React.ReactElement {
  return (
    <div
      style={{
        position: 'relative',
        height,
        borderRadius: 10,
        border: `1px solid ${C.line}`,
        overflow: 'hidden',
        background: 'radial-gradient(110% 80% at 25% 15%, #17222c 0%, #0c1116 55%, #06090c 100%)'
      }}
    >
      <div
        style={{
          position: 'absolute',
          inset: 0,
          opacity: 0.16,
          background:
            'repeating-linear-gradient(60deg, transparent 0 38px, rgba(255,255,255,0.05) 38px 39px), repeating-linear-gradient(-60deg, transparent 0 38px, rgba(255,255,255,0.05) 38px 39px)'
        }}
      />
      <div
        style={{
          position: 'absolute',
          left: 12,
          top: 9,
          fontSize: 9,
          color: C.dim,
          letterSpacing: 0.4
        }}
      >
        {label}
      </div>
      {children}
    </div>
  )
}

function Rows({ dimFirst = false }: { dimFirst?: boolean }): React.ReactElement {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
      {ROWS.map((row, i) => (
        <div
          key={row.orig}
          style={{
            display: 'flex',
            gap: 8,
            padding: '5px 9px',
            borderLeft: `2px solid ${row.hero}`,
            background: 'rgba(7,9,12,0.72)',
            backdropFilter: 'blur(2px)',
            borderRadius: 4,
            opacity: dimFirst && i === 2 ? 0.35 : 1
          }}
        >
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, color: C.text, whiteSpace: 'nowrap' }}>{row.trans}</div>
            <div style={{ fontSize: 9, color: C.dim, marginTop: 1, whiteSpace: 'nowrap' }}>
              {row.orig}
            </div>
          </div>
          <div
            style={{
              marginLeft: 'auto',
              fontSize: 9,
              color: row.tone === 'ok' ? C.accent : C.warn,
              whiteSpace: 'nowrap'
            }}
          >
            {row.spoken}
          </div>
        </div>
      ))}
    </div>
  )
}

export type SummonTab = 'history' | 'phrases' | 'suggest' | 'look'
export function OverlayPreview({
  initialTab = 'history'
}: { initialTab?: SummonTab } = {}): React.ReactElement {
  const [tab, setTab] = React.useState<SummonTab>(initialTab)

  return (
    <div style={{ height: '100vh', background: C.bg, overflowY: 'auto', color: C.text }}>
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '20px 20px 40px' }}>
        <div style={{ fontSize: 13, fontWeight: 600 }}>浮层本体 · 四个形态</div>
        <div style={{ fontSize: 11, color: C.dim, marginTop: 4, lineHeight: 1.7 }}>
          浮层不是面板里的一页，它是贴在游戏上的一层窗口。这里按对局里真实会出现的四种样子画一遍。
        </div>

        <div style={{ marginTop: 16 }}>
          <GameCanvas label="展开 · 未锁定（工具条会自己在 5 秒后消失并锁上）" height={320}>
            <div style={{ position: 'absolute', left: 14, top: 26, right: 14 }}>
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '4px 8px',
                  marginBottom: 6,
                  borderRadius: 5,
                  background: 'rgba(47,230,168,0.10)',
                  border: `1px solid rgba(47,230,168,0.28)`,
                  fontSize: 9
                }}
              >
                <span style={{ color: C.accent }}>未锁定</span>
                <span style={{ color: C.dim }}>420×132 · 5 秒后自动锁定</span>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, color: C.dim }}>
                  <span>还原</span>
                  <span style={{ color: C.accent }}>朗读：开</span>
                  <span>收起</span>
                  <span>锁定</span>
                </span>
              </div>
              <Rows dimFirst />
              <div style={{ marginTop: 5, fontSize: 9, color: C.dim }}>
                按住 Alt+Shift+V 说话 · 中译英
              </div>
              <div
                style={{
                  position: 'absolute',
                  right: -6,
                  top: 10,
                  bottom: 10,
                  width: 3,
                  background: 'rgba(47,230,168,0.5)',
                  borderRadius: 2
                }}
              />
            </div>
          </GameCanvas>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10, marginTop: 10 }}>
          <GameCanvas label="展开 · 已锁定" height={170}>
            <div style={{ position: 'absolute', left: 14, top: 26, right: 14 }}>
              <Rows dimFirst />
            </div>
          </GameCanvas>

          <GameCanvas label="收起 · 132×34" height={170}>
            <div
              style={{
                position: 'absolute',
                left: 14,
                top: 30,
                display: 'flex',
                alignItems: 'center',
                gap: 6,
                height: 30,
                padding: '0 10px',
                borderRadius: 6,
                background: 'rgba(7,9,12,0.82)',
                border: `1px solid ${C.line}`,
                fontSize: 10
              }}
            >
              <span style={{ color: C.dim }}>🔒</span>
              <span>翻译区</span>
              <span
                style={{
                  marginLeft: 4,
                  padding: '0 4px',
                  borderRadius: 999,
                  background: C.accent,
                  color: '#06231a',
                  fontSize: 8,
                  fontWeight: 700
                }}
              >
                3
              </span>
            </div>
            <div style={{ position: 'absolute', left: 14, bottom: 12, fontSize: 9, color: C.dim }}>
              点一下展开；未锁定时还能拖走
            </div>
          </GameCanvas>
        </div>

        <div style={{ marginTop: 10 }}>
          <GameCanvas label="呼出面板 · Alt+Shift+H（浮层临时变成能点的纸条）" height={286}>
            <div
              style={{
                position: 'absolute',
                left: 14,
                top: 26,
                width: 300,
                maxHeight: 240,
                overflow: 'hidden',
                borderRadius: 8,
                background: 'rgba(10,14,18,0.94)',
                border: `1px solid ${C.line}`
              }}
            >
              <div
                style={{ display: 'flex', gap: 2, padding: 6, borderBottom: `1px solid ${C.line}` }}
              >
                {(
                  [
                    ['history', '历史'],
                    ['phrases', '短语'],
                    ['suggest', 'AI 建议'],
                    ['look', '看一眼']
                  ] as const
                ).map(([id, label]) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
                    style={{
                      border: 'none',
                      cursor: 'pointer',
                      borderRadius: 5,
                      padding: '3px 9px',
                      fontSize: 10,
                      background: tab === id ? 'rgba(47,230,168,0.14)' : 'transparent',
                      color: tab === id ? C.accent : C.dim
                    }}
                  >
                    {label}
                  </button>
                ))}
              </div>
              {tab === 'look' ? (
                <div style={{ padding: 10, display: 'grid', gap: 8 }}>
                  <button
                    type="button"
                    style={{
                      cursor: 'pointer',
                      border: '1px solid rgba(47,230,168,0.5)',
                      background: 'rgba(47,230,168,0.14)',
                      color: C.accent,
                      borderRadius: 6,
                      padding: '6px 0',
                      fontSize: 11
                    }}
                  >
                    看一眼
                  </button>
                  <div style={{ fontSize: 10, lineHeight: 1.75, color: C.text }}>
                    敌方三人刚在下路露头，肉山没点眼；我方两个 BKB 都在冷却。
                  </div>
                  <div style={{ fontSize: 9, lineHeight: 1.75, color: C.dim }}>
                    点「看一眼」才截屏：不按就不花钱，也不会上传任何画面。热键 Alt+Shift+G
                    同样直接问一次。
                  </div>
                </div>
              ) : (
                <div style={{ padding: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
                  {(tab === 'history'
                    ? ['推下路', '他们主 C 有 BKB', '眼没了', 'gg push bot']
                    : tab === 'phrases'
                      ? ['别追，等我先手', 'Need wards here', 'Care, they smoke']
                      : ['问一句：谁来中路？', '提醒：肉山 1 分钟', '回一句：我先买跳']
                  ).map((line) => (
                    <div
                      key={line}
                      style={{
                        padding: '5px 8px',
                        borderRadius: 5,
                        background: 'rgba(255,255,255,0.03)',
                        fontSize: 10,
                        color: C.text
                      }}
                    >
                      {line}
                    </div>
                  ))}
                </div>
              )}
              <div
                style={{
                  padding: '5px 9px',
                  fontSize: 9,
                  color: C.dim,
                  borderTop: `1px solid ${C.line}`
                }}
              >
                {tab === 'look' ? '不按就不截屏 · 每次都是真的模型调用' : '点一行即复制 · Esc 关掉'}
              </div>
            </div>
          </GameCanvas>
        </div>

        <div style={{ marginTop: 14, fontSize: 11, color: C.dim, lineHeight: 1.9 }}>
          四条不变式：锁定时整层点击穿透、截图里也看不见；工具条只在未锁定时出现；收起态只占
          132×34；
          呼出面板是唯一「既能点又能被截到」的形态。想要看见浮层，先解锁——这是所有「浮层怎么不见了」问题的根。
        </div>
      </div>
    </div>
  )
}
