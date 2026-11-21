/**
 * 浮层：屏幕上那一层。这一页只调「长什么样、放哪里」，不调「念什么」。
 *
 * 右上角嵌一个真的小浮层，改字号/底色/摘要立刻能在上面看到 —— 这页最怕的就是「调完不知道调成什么样」。
 */
import * as React from 'react'

import { Btn, Card, Chips, KV, Pill, Row, SectionTitle, Slider, Toggle } from '../kit'
import { C, FS, MONO } from '../tokens'

const FONTS = [
  { id: 'small', label: '小 · 11/9' },
  { id: 'normal', label: '中 · 13/11' },
  { id: 'large', label: '大 · 15/13' }
] as const

const MODES = [
  { id: 'both', label: '原文 + 译文' },
  { id: 'trans', label: '只译文' },
  { id: 'orig', label: '只原文' }
] as const

export function OverlayPage(): React.ReactElement {
  const [visible, setVisible] = React.useState(true)
  const [opacity, setOpacity] = React.useState(85)
  const [font, setFont] = React.useState<(typeof FONTS)[number]['id']>('normal')
  const [mode, setMode] = React.useState<(typeof MODES)[number]['id']>('both')
  const [digest, setDigest] = React.useState(false)
  const [auto, setAuto] = React.useState(true)
  const [locked, setLocked] = React.useState(true)

  const bodySize = font === 'small' ? 11 : font === 'large' ? 15 : 13
  const metaSize = font === 'small' ? 9 : font === 'large' ? 13 : 11

  return (
    <div>
      <Card>
        <SectionTitle note="这一层永远是置顶的独立窗口。它看不见鼠标的时候就是锁定了。">
          显示
        </SectionTitle>
        <Row
          label="窗口"
          hint="Alt+Shift+O 显示 / 隐藏"
          note={
            visible
              ? '显示中。锁定时鼠标穿透、截图里也没有它。'
              : '已经隐藏。说话键会把它重新叫出来，所以别用它当「省性能」的开关。'
          }
          control={
            <>
              <Btn small onClick={() => setVisible(!visible)}>
                {visible ? '隐藏' : '显示'}
              </Btn>
              <Pill tone={visible ? 'ok' : 'idle'}>{visible ? '显示中' : '已隐藏'}</Pill>
            </>
          }
          last
        />
      </Card>

      <Card>
        <SectionTitle note="改这里，右上角的小浮层立刻变 —— 不用去游戏里试。">外观</SectionTitle>
        <Row
          stacked
          label="底色深浅"
          control={<Slider value={opacity} min={40} max={100} onChange={setOpacity} suffix="%" />}
        />
        <Row
          label="字号"
          note="三档在 overlay-a11y 里各有像素值；脏值一律回落到「中」。"
          control={<Chips value={font} onChange={setFont} options={FONTS.map((f) => ({ ...f }))} />}
        />
        <Row
          label="显示模式"
          control={<Chips value={mode} onChange={setMode} options={MODES.map((m) => ({ ...m }))} />}
        />
        <Row
          label="战况摘要"
          hint="抬头先给一行"
          note="只搬已有行，不花模型调用。关掉时抬头就是「对局中 · 4 段就绪」。"
          control={<Toggle on={digest} onChange={setDigest} label={digest ? '开' : '关'} />}
          last
        />
      </Card>

      <Card>
        <SectionTitle note="拖到哪就记到哪，按物理像素存，换缩放比例也不会跑掉。">
          位置
        </SectionTitle>
        <Row
          label="当前几何"
          control={
            <span style={{ fontFamily: MONO, fontSize: FS.small, color: C.dim }}>
              right 24 · top 88 · 420×132
            </span>
          }
        />
        <Row
          label="复位"
          note="回到右上角默认位置。"
          control={<Btn small>复位到右上角</Btn>}
          last
        />
      </Card>

      <Card>
        <SectionTitle>对局</SectionTitle>
        <Row
          label="开机自动捕获"
          note="启动后就盯着屏幕，不用每次手动开始。"
          control={<Toggle on={auto} onChange={setAuto} label={auto ? '开' : '关'} />}
        />
        <Row
          label="Dota 2 显示模式"
          note="独占全屏（exclusive fullscreen）时没有任何窗口能画在游戏上面 —— 换「全屏窗口」即可；这不是浮层的问题。"
          noteTone="warn"
          control={<Pill tone="warn">独占全屏</Pill>}
        />
        <Row
          label="我的昵称"
          note="用来认出哪句是自己说的；多个名字用逗号分开。"
          control={
            <span style={{ fontFamily: MONO, fontSize: FS.small, color: C.dim }}>
              mystery4f, 老谢
            </span>
          }
        />
        <Row
          label="锁定与截图"
          note="锁定 = 鼠标穿透 + 内容保护：窗口截图里也不会出现它。呼出面板（Alt+Shift+H）时会临时解锁。"
          control={<Toggle on={locked} onChange={setLocked} label={locked ? '已锁定' : '可拖动'} />}
        />
        <Row
          label="热键"
          note="显示 / 锁定 / 收起 / 呼出 / 看一眼画面，都在热键页改。"
          control={<Btn small>去热键页</Btn>}
          last
        />
      </Card>

      <SectionTitle note="这是浮层现在的样子（跟随上面的字号与底色）。">实时预览</SectionTitle>
      <div
        style={{
          border: `1px solid ${C.line}`,
          borderRadius: 10,
          padding: 18,
          background: 'linear-gradient(135deg,#12202a,#0a0f14 60%,#141a12)',
          display: 'flex',
          justifyContent: 'flex-end'
        }}
      >
        <div
          style={{
            width: 420,
            background: `rgba(8,11,15,${opacity / 100})`,
            border: `1px solid ${C.line2}`,
            borderRadius: 8,
            padding: '8px 10px',
            fontFamily: 'inherit'
          }}
        >
          {digest ? (
            <div style={{ fontSize: metaSize, color: C.info, marginBottom: 5 }}>
              对局中 18:42 · 落后 3k · 肉山 40 s
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
            <span
              style={{ width: 3, height: metaSize + 3, background: C.accent, borderRadius: 2 }}
            />
            <span style={{ fontSize: metaSize, color: C.dim }}>队友 · 12:07</span>
            <span style={{ fontSize: bodySize, color: C.text }}>他们开雾了，中路小心</span>
          </div>
          <div style={{ fontSize: metaSize, color: C.dim, marginLeft: 11 }}>
            They smoked, careful mid
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginTop: 6 }}>
            <span style={{ width: 3, height: metaSize + 3, background: C.warn, borderRadius: 2 }} />
            <span style={{ fontSize: metaSize, color: C.dim }}>我 · 12:06</span>
            {mode !== 'trans' ? (
              <span style={{ fontSize: bodySize, color: C.text }}>等我一下，买活</span>
            ) : null}
          </div>
        </div>
      </div>
      <div style={{ height: 10 }} />
      <Card>
        <KV
          columns={2}
          items={[
            ['窗口类', 'alwaysOnTop + skipTaskbar'],
            ['锁定行为', 'ignoreMouseEvents(true) + setContentProtection(true)'],
            ['几何', 'DIP，按主屏 scaleFactor 换算'],
            ['字号来源', 'src/shared/overlay-a11y.ts']
          ]}
        />
        <div style={{ marginTop: 8, fontSize: FS.small, color: C.dim }}>
          灰色的「显示中」和下面这两行都不是设置项，是这一层的真实状态；锁定时截图里看不到它，不代表它没显示。
        </div>
      </Card>
    </div>
  )
}
