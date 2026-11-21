/**
 * 驾驶室（新形态第一屏）。
 * 这一屏只回答三个问题：现在几点了、现在该做什么、我现在能不能马上说一句。
 * 它不描述管道 —— 管道只在「接线」里出现，而接线平时不出现。
 *
 * 与旧面板的根本区别：旧面板按「模块」组织（听/说/浮层/引擎/训练），
 * 这一屏按「一局的时间」组织，模块只在需要它的时候被点名。
 */
import * as React from 'react'

import { Btn, Chips, Pill, SelectBox, Toggle } from '../kit'
import { C, FS, MONO, SP } from '../tokens'

type Tone = 'idle' | 'warn' | 'ok' | 'bad'

type Beat = {
  id: string
  t: string
  what: string
  who: string
  tone: Tone
  act: string
  doneNote?: string
}

const BEATS: Beat[] = [
  {
    id: 'rosh',
    t: '18:42',
    what: '肉山 40 秒后刷新',
    who: '计时',
    tone: 'warn',
    act: '去布视野',
    doneNote: '已在浮层标出，队友看得见'
  },
  {
    id: 'buyback',
    t: '18:10',
    what: '敌法、巫医都买了回',
    who: '对局正文',
    tone: 'warn',
    act: '强推下路'
  },
  {
    id: 'mid',
    t: '17:36',
    what: '老张：中路没眼，等我一下',
    who: '队友',
    tone: 'idle',
    act: '翻译并直发'
  },
  {
    id: 'vanish',
    t: '17:12',
    what: '对面 5 个人同时从小地图上消失了',
    who: '小地图',
    tone: 'warn',
    act: '缩一下'
  },
  {
    id: 'said',
    t: '16:48',
    what: '你说：让他们开雾，我买活',
    who: '你',
    tone: 'ok',
    act: '再说一次',
    doneNote: '已说成英文，队列里没人抢话'
  },
  {
    id: 'rune',
    t: '16:20',
    what: '智慧符 40 秒后刷',
    who: '计时',
    tone: 'idle',
    act: '走符点'
  }
]

type Mate = { id: string; name: string; line: string; tone: 'idle' | 'ok' | 'warn'; muted: boolean }

const INITIAL_MATES: Mate[] = [
  { id: 'zhang', name: '老张', line: '中路没眼，等我一下', tone: 'warn', muted: false },
  { id: 'wang', name: '小王', line: '刚说完 · 已念成中文', tone: 'ok', muted: false },
  { id: 'hui', name: '阿辉', line: '在说话…', tone: 'ok', muted: false },
  { id: 'me', name: '我', line: '按住说中文，出去是英文', tone: 'idle', muted: false },
  { id: 'noise', name: '对面', line: '不进这条链', tone: 'idle', muted: true }
]

const VERBS = [
  { id: 'helm', label: '这一局' },
  { id: 'learn', label: '平时' },
  { id: 'wire', label: '接线' }
] as const

export function HelmPage(): React.ReactElement {
  const [beats, setBeats] = React.useState<Beat[]>(BEATS)
  const [said, setSaid] = React.useState<string>('')
  const [listening, setListening] = React.useState(false)
  const [mates, setMates] = React.useState<Mate[]>(INITIAL_MATES)
  /** 说/听的全部设置收进一个抽屉：对局中不该看的东西，一页都不给。 */
  const [drawer, setDrawer] = React.useState(false)
  const [rate, setRate] = React.useState(1.05)
  const [voice, setVoice] = React.useState<'jenny' | 'xie' | 'seed'>('jenny')
  const [translate, setTranslate] = React.useState<'both' | 'zh'>('both')
  const [cmd, setCmd] = React.useState('')
  const [ack, setAck] = React.useState('')
  const VOICES = { jenny: 'Jenny · 英式女声', xie: '老谢-中文-1218', seed: '晓晓保底' }
  /**
   * 语音驾驶：一句人话就等于一次设置改动。
   * 这里只认四条最高频的，其余老实说没听懂 —— 不要猜。
   */
  const say = (raw: string): void => {
    const t = raw.trim()
    if (!t) return
    setCmd('')
    if (/大声|大点声|快一点/.test(t)) {
      const v = Math.min(2, Number((rate + 0.1).toFixed(2)))
      setRate(v)
      setAck(`语速调到 ${v.toFixed(2)}× · 下一句就生效`)
      return
    }
    if (/小点声|慢一点/.test(t)) {
      const v = Math.max(0.6, Number((rate - 0.1).toFixed(2)))
      setRate(v)
      setAck(`语速调到 ${v.toFixed(2)}×`)
      return
    }
    if (/换.{0,2}(声音|音色)/.test(t)) {
      const order = ['jenny', 'xie', 'seed'] as const
      const next = order[(order.indexOf(voice) + 1) % order.length]
      setVoice(next)
      setAck(`已切到 ${VOICES[next]} · 朗读和声出一起换`)
      return
    }
    if (/别说英语|不翻|只发中文/.test(t)) {
      setTranslate('zh')
      setAck('已改成只发中文原文，不再翻成英语')
      return
    }
    const who = t.match(/关掉(\S+)/)
    if (who) {
      const hit = mates.find((x) => x.name === who[1])
      if (hit) {
        setMates((prev) => prev.map((x) => (x.id === hit.id ? { ...x, muted: true } : x)))
        setAck(`已关掉 ${hit.name} 的朗读，其他人照旧念`)
        return
      }
      setAck(`没有叫「${who[1]}」的队友`)
      return
    }
    setAck('没听懂。能说的有：大点声 / 换个声音 / 别说英语 / 关掉老张')
  }

  const doBeat = (id: string): void => {
    setBeats((prev) =>
      prev.map((b) =>
        b.id === id ? { ...b, tone: 'ok' as Tone, doneNote: b.doneNote ?? '已发出' } : b
      )
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP.gap }}>
      {/* 一局的抬头：比分、经济、下一件事。没有「状态卡片」，只有一行事实。 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'stretch',
          gap: 0,
          border: `1px solid ${C.line2}`,
          borderRadius: 10,
          overflow: 'hidden',
          background: C.card
        }}
      >
        <div style={{ padding: '12px 16px', borderRight: `1px solid ${C.line}` }}>
          <div style={{ fontFamily: MONO, fontSize: 22, color: C.text, lineHeight: 1 }}>18:42</div>
          <div style={{ fontSize: FS.mini, color: C.dim, marginTop: 4 }}>天辉 · 夜 3</div>
        </div>
        <div style={{ padding: '12px 16px', borderRight: `1px solid ${C.line}` }}>
          <div style={{ fontFamily: MONO, fontSize: 18, color: C.text }}>
            24 <span style={{ color: C.dim }}>:</span> 21
          </div>
          <div style={{ fontSize: FS.mini, color: C.dim, marginTop: 4 }}>击杀 · 我们在左</div>
        </div>
        <div style={{ padding: '12px 16px', borderRight: `1px solid ${C.line}` }}>
          <div style={{ fontFamily: MONO, fontSize: 18, color: C.danger }}>−3.1k</div>
          <div style={{ fontSize: FS.mini, color: C.dim, marginTop: 4 }}>经济差</div>
        </div>
        <div
          style={{ flex: 1, padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 10 }}
        >
          <Pill tone="warn">下一件事</Pill>
          <span style={{ fontSize: FS.body, color: C.text }}>肉山 40 秒后刷新 —— 先去布视野</span>
        </div>
        <div style={{ padding: '12px 16px', display: 'flex', alignItems: 'center', gap: 6 }}>
          {VERBS.map((v) => (
            <span
              key={v.id}
              style={{
                fontSize: FS.mini,
                color: v.id === 'helm' ? C.text : C.dim,
                borderBottom: v.id === 'helm' ? `1px solid ${C.accent}` : '1px solid transparent',
                paddingBottom: 2
              }}
            >
              {v.label}
            </span>
          ))}
        </div>
      </div>

      {/* 主区：一条时间线。每条都能直接变成动作，动作做完就变成记录。 */}
      <div style={{ border: `1px solid ${C.line2}`, borderRadius: 10, background: C.card }}>
        {beats.map((b, i) => (
          <div
            key={b.id}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 14,
              padding: '12px 16px',
              borderTop: i === 0 ? 'none' : `1px solid ${C.line}`
            }}
          >
            <span
              style={{
                fontFamily: MONO,
                fontSize: FS.small,
                color: C.dim,
                width: 44,
                paddingTop: 2
              }}
            >
              {b.t}
            </span>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: FS.body, color: b.tone === 'ok' ? C.dim : C.text }}>
                {b.what}
              </div>
              <div style={{ fontSize: FS.mini, color: C.dim, marginTop: 3 }}>
                {b.who}
                {b.doneNote ? ` · ${b.doneNote}` : ''}
              </div>
            </div>
            <div style={{ flex: '0 0 auto' }}>
              {b.tone === 'ok' ? (
                <Pill tone="ok">已办</Pill>
              ) : (
                <Btn small primary={b.tone === 'warn'} onClick={() => doBeat(b.id)}>
                  {b.act}
                </Btn>
              )}
            </div>
          </div>
        ))}
      </div>

      {/* 五个频道：队友不是名字，是五个可以单独关掉的通道。 */}
      <div style={{ display: 'flex', gap: SP.tight, flexWrap: 'wrap' }}>
        {mates.map((m) => (
          <button
            key={m.id}
            onClick={() =>
              setMates((prev) => prev.map((x) => (x.id === m.id ? { ...x, muted: !x.muted } : x)))
            }
            style={{
              flex: '1 1 0',
              minWidth: 148,
              textAlign: 'left',
              padding: '9px 12px',
              borderRadius: 9,
              border: `1px solid ${m.muted ? C.line : C.line2}`,
              background: m.muted ? 'transparent' : C.card,
              color: m.muted ? C.dim : C.text,
              cursor: 'pointer',
              opacity: m.muted ? 0.6 : 1
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <span
                style={{ color: m.tone === 'ok' ? C.accent : m.tone === 'warn' ? C.warn : C.dim }}
              >
                {m.tone === 'ok' ? '●' : m.tone === 'warn' ? '◍' : '○'}
              </span>
              <span style={{ fontSize: FS.small }}>{m.name}</span>
              <span style={{ marginLeft: 'auto', fontSize: FS.mini, color: C.dim }}>
                {m.muted
                  ? '关朗读'
                  : m.tone === 'ok'
                    ? '在说'
                    : m.tone === 'warn'
                      ? '没出中文'
                      : '在线'}
              </span>
            </div>
            <div
              style={{
                fontSize: FS.mini,
                color: C.dim,
                marginTop: 5,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis'
              }}
            >
              {m.line}
            </div>
          </button>
        ))}
      </div>

      {/* 输入区：产品真正的三个动作，永远在同一位置。 */}
      <div style={{ display: 'grid', gridTemplateColumns: '1.4fr 1fr 1fr', gap: SP.gap }}>
        <button
          onClick={() => {
            setListening((v) => !v)
            setSaid(listening ? '' : '中')
          }}
          style={{
            textAlign: 'left',
            padding: '14px 16px',
            borderRadius: 10,
            border: `1px solid ${listening ? C.accent : C.line2}`,
            background: listening ? 'rgba(55,226,164,0.08)' : C.card,
            color: C.text,
            cursor: 'pointer'
          }}
        >
          <div style={{ fontSize: FS.body, color: listening ? C.accent : C.text }}>
            {listening ? '● 在听你说…' : '按住说话'}
          </div>
          <div style={{ fontSize: FS.mini, color: C.dim, marginTop: 6 }}>
            Alt+Shift+V · 说完自动翻成英文说给队友
          </div>
        </button>
        <button
          style={{
            textAlign: 'left',
            padding: '14px 16px',
            borderRadius: 10,
            border: `1px solid ${C.line2}`,
            background: C.card,
            color: C.text,
            cursor: 'pointer'
          }}
        >
          <div style={{ fontSize: FS.body }}>看一眼</div>
          <div style={{ fontSize: FS.mini, color: C.dim, marginTop: 6 }}>
            Alt+Shift+G · 只在你按的时候截图
          </div>
        </button>
        <button
          style={{
            textAlign: 'left',
            padding: '14px 16px',
            borderRadius: 10,
            border: `1px solid ${C.line2}`,
            background: C.card,
            color: C.text,
            cursor: 'pointer'
          }}
        >
          <div style={{ fontSize: FS.body }}>呼出</div>
          <div style={{ fontSize: FS.mini, color: C.dim, marginTop: 6 }}>
            Alt+Shift+H · 历史 / 短语 / 建议
          </div>
        </button>
      </div>

      {/* 一行反馈：它在听什么、它刚做了什么。语音驾驶的全部界面就是这一行。 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          padding: '9px 14px',
          border: `1px solid ${C.line}`,
          borderRadius: 8,
          background: C.card2,
          fontSize: FS.small,
          color: C.dim
        }}
      >
        <span style={{ color: listening ? C.accent : C.dim }}>{listening ? '●' : '○'}</span>
        <span style={{ flex: 1 }}>
          {listening
            ? '识别中… 你说完松开就翻，翻完直接用队友的声音念出来'
            : said === '中'
              ? '刚发出去：Let them smoke, I have buyback'
              : '它在听游戏里的说话（只在你说的时候），没在录你自己的麦'}
        </span>
        <span style={{ fontFamily: MONO, fontSize: FS.mini }}>这一局已说 4 句 · 平均 1.8 s</span>
      </div>
      {/* 用嘴改设置：这一行取代了旧面板「说话」21 行 + 「听话」15 行。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: SP.gap }}>
        <input
          value={cmd}
          onChange={(e) => setCmd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') say(cmd)
          }}
          placeholder="用嘴改：大点声 / 换个声音 / 别说英语 / 关掉老张"
          style={{
            flex: 1,
            padding: '9px 12px',
            borderRadius: 8,
            border: `1px solid ${C.line2}`,
            background: C.card2,
            color: C.text,
            fontSize: FS.small,
            outline: 'none'
          }}
        />
        <Btn small onClick={() => say(cmd)}>
          说这个
        </Btn>
        <Btn small onClick={() => setDrawer((v) => !v)}>
          全部调整
        </Btn>
      </div>
      {ack ? (
        <div style={{ fontSize: FS.small, color: C.accent, paddingLeft: 2 }}>↳ {ack}</div>
      ) : null}

      {/* 抽屉：说与听的全部设置。对局中它默认关着，只有主动点「全部调整」才出现。 */}
      {drawer ? (
        <div
          style={{
            position: 'fixed',
            top: 0,
            right: 0,
            bottom: 0,
            width: 372,
            background: C.card,
            borderLeft: `1px solid ${C.line2}`,
            padding: 16,
            display: 'flex',
            flexDirection: 'column',
            gap: 12,
            overflow: 'auto',
            zIndex: 20
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center' }}>
            <span style={{ fontSize: FS.body, fontWeight: 600 }}>说与听</span>
            <span style={{ marginLeft: 'auto' }}>
              <Btn small onClick={() => setDrawer(false)}>
                收起
              </Btn>
            </span>
          </div>

          <div style={{ fontSize: FS.mini, color: C.dim }}>听 · 你说话</div>
          <div style={{ fontSize: FS.small }}>
            讲话设备 <span style={{ color: C.dim }}>麦克风阵列（Realtek）</span>
          </div>
          <div style={{ fontSize: FS.small }}>
            识别引擎 <span style={{ color: C.dim }}>Qwen3-ASR 0.6B · 799 MB</span>
          </div>

          <div style={{ fontSize: FS.mini, color: C.dim, marginTop: 4 }}>说 · 出去是什么</div>
          <Chips
            options={[
              { id: 'both', label: '中文进 · 英文出' },
              { id: 'zh', label: '只发中文原文' }
            ]}
            value={translate}
            onChange={setTranslate}
          />
          <SelectBox
            options={[
              { id: 'jenny', label: VOICES.jenny },
              { id: 'xie', label: VOICES.xie },
              { id: 'seed', label: VOICES.seed }
            ]}
            value={voice}
            onChange={setVoice}
          />
          <div style={{ fontSize: FS.small }}>
            语速 <span style={{ fontFamily: MONO, color: C.text }}>{rate.toFixed(2)}×</span>{' '}
            <span style={{ color: C.dim }}>（0.60 – 2.00）</span>
          </div>

          <div style={{ fontSize: FS.mini, color: C.dim, marginTop: 4 }}>念 · 别人的字</div>
          <Toggle
            on={!mates.find((m) => m.id === 'zhang')?.muted}
            onChange={() => {
              setMates((prev) =>
                prev.map((m) => (m.id === 'zhang' ? { ...m, muted: !m.muted } : m))
              )
            }}
            label="老张说的话念出来"
          />
          <Toggle on onChange={() => undefined} label="自己的话也念一遍（会和自己抢声）" />

          <div style={{ fontSize: FS.mini, color: C.dim, marginTop: 4 }}>只有这里有设置</div>
          <div style={{ fontSize: FS.mini, color: C.dim, lineHeight: 1.6 }}>
            旧面板把「说话」和「听话」拆成两页、36 个设置行。这里只剩 6 个 ——
            其余（引擎地址、密钥、模型、训练、词表）都在「平时」，对局中不出现。
          </div>
        </div>
      ) : null}
    </div>
  )
}
