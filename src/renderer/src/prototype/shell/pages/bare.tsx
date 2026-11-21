/**
 * 无窗口形态：产品默认没有主界面。
 * 桌面上只有一条 132×34 的浮层和三个热键；面板只在「装环境 / 训练 / 查日志」时才开窗口。
 *
 * 这一屏是给老板看「没有面板长什么样」，所以它画的是桌面，不是应用窗口。
 */
import * as React from 'react'

import { C, FS, MONO, SP } from '../tokens'

type Phase = 'idle' | 'listening' | 'speaking'

const PHASES: { id: Phase; label: string; mark: string; note: string }[] = [
  { id: 'idle', label: '待命', mark: '○', note: '听游戏里的说话；你不按不说话' },
  { id: 'listening', label: '在听你', mark: '◍', note: '松开就翻，翻完立刻念给队友' },
  { id: 'speaking', label: '在念', mark: '≈', note: '这时候不收麦，免得听见自己' }
]

export function BarePage(): React.ReactElement {
  const [phase, setPhase] = React.useState<Phase>('idle')

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP.gap }}>
      <div style={{ fontSize: FS.small, color: C.dim }}>
        产品默认没有主界面。下面这块深色区域就是「桌面」—— 它只多了一条 132×34。
      </div>

      {/* 假桌面：一条浮层贴右上角，其余什么都没有 */}
      <div
        style={{
          position: 'relative',
          height: 320,
          borderRadius: 10,
          border: `1px solid ${C.line2}`,
          background: 'radial-gradient(120% 90% at 30% 20%, #16202a 0%, #0a0f14 55%, #06080b 100%)',
          overflow: 'hidden'
        }}
      >
        <div style={{ position: 'absolute', left: 16, top: 14, fontSize: FS.mini, color: C.dim }}>
          桌面 · 1440×900 · 游戏在跑
        </div>

        {/* 那一条 */}
        <div
          style={{
            position: 'absolute',
            right: 24,
            top: 24,
            width: 132,
            height: 34,
            borderRadius: 8,
            border: `1px solid ${phase === 'idle' ? C.line2 : C.accent}`,
            background: 'rgba(8,11,15,0.86)',
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            padding: '0 8px',
            color: C.text
          }}
        >
          <span style={{ color: phase === 'idle' ? C.dim : C.accent, fontSize: 13 }}>
            {PHASES.find((p) => p.id === phase)?.mark}
          </span>
          <span style={{ fontFamily: MONO, fontSize: FS.small }}>18:42</span>
          <span style={{ marginLeft: 'auto', fontSize: FS.mini, color: C.warn }}>2</span>
        </div>

        {/* 三个热键，画在桌面下方当作提示，不是窗口 */}
        <div
          style={{
            position: 'absolute',
            left: 16,
            bottom: 16,
            display: 'flex',
            gap: 8,
            flexWrap: 'wrap'
          }}
        >
          {[
            ['Alt+Shift+V', '按住说中文'],
            ['Alt+Shift+G', '看一眼画面'],
            ['Alt+Shift+H', '呼出面板']
          ].map(([k, v]) => (
            <span
              key={k}
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '5px 9px',
                borderRadius: 7,
                border: `1px solid ${C.line}`,
                background: 'rgba(8,11,15,0.6)',
                fontSize: FS.mini,
                color: C.dim
              }}
            >
              <span style={{ fontFamily: MONO, color: C.text }}>{k}</span>
              {v}
            </span>
          ))}
        </div>
      </div>

      {/* 三种形态：同一条，只有形状和颜色变，颜色之外还有符号 */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: SP.gap }}>
        {PHASES.map((p) => (
          <button
            key={p.id}
            onClick={() => setPhase(p.id)}
            style={{
              textAlign: 'left',
              padding: '11px 13px',
              borderRadius: 9,
              border: `1px solid ${phase === p.id ? C.accent : C.line2}`,
              background: phase === p.id ? 'rgba(55,226,164,0.07)' : C.card,
              color: C.text,
              cursor: 'pointer'
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span style={{ color: p.id === 'idle' ? C.dim : C.accent }}>{p.mark}</span>
              <span style={{ fontSize: FS.small }}>{p.label}</span>
            </div>
            <div style={{ fontSize: FS.mini, color: C.dim, marginTop: 6, lineHeight: 1.5 }}>
              {p.note}
            </div>
          </button>
        ))}
      </div>

      {/* 唯一还会开窗口的三件事 */}
      <div style={{ border: `1px solid ${C.line2}`, borderRadius: 10, background: C.card }}>
        <div
          style={{ padding: '11px 14px', borderBottom: `1px solid ${C.line}`, fontSize: FS.small }}
        >
          只有这三件事会开窗口（其余全在浮层与热键里）
        </div>
        {[
          ['装环境', '第一次装 Python / 模型 / 虚拟声卡', '装完就不再出现'],
          ['训练', '音色训练、识别训练、测一遍', '跑完关掉'],
          ['查日志', '它出错了，要把现场交出去', '只在你要看的时候']
        ].map(([t, d, n], i) => (
          <div
            key={t}
            style={{
              display: 'flex',
              alignItems: 'baseline',
              gap: 12,
              padding: '10px 14px',
              borderTop: i === 0 ? 'none' : `1px solid ${C.line}`
            }}
          >
            <span style={{ fontSize: FS.small, width: 56 }}>{t}</span>
            <span style={{ fontSize: FS.small, color: C.dim, flex: 1 }}>{d}</span>
            <span style={{ fontSize: FS.mini, color: C.dim }}>{n}</span>
          </div>
        ))}
      </div>

      <div style={{ fontSize: FS.mini, color: C.dim, lineHeight: 1.7 }}>
        对比现在：现在开机就是一个 1120 px 宽、十三页、60 个设置的面板，你得先想「我要改哪个」。
        这一形态里没有那个问题 —— 只有三个热键和一条 132×34，剩下的事它自己做；
        做不了的时候，它才开窗口问你。
      </div>
    </div>
  )
}
