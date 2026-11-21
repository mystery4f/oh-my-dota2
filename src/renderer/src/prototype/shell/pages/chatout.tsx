/**
 * 直发：把中文打进游戏聊天框（先翻译），而不是念出来。
 *
 * 这一页的每一个字都在解释同一件事：它只动「聊天框里的草稿」，不按发送键之外的东西。
 */
import * as React from 'react'

import { Banner, Btn, Card, Chips, Pill, Row, SectionTitle, SelectBox, Table, Toggle } from '../kit'
import { C, FS, MONO } from '../tokens'

const PHRASES = [
  { id: 'p1', zh: '等我一下', en: 'Wait for me', tone: '平静' },
  { id: 'p2', zh: '买活', en: 'Buyback', tone: '紧迫' },
  { id: 'p3', zh: '他们开雾了', en: 'They smoked', tone: '报点' },
  { id: 'p4', zh: '谢谢', en: 'Thanks', tone: '缓和' }
]

export function ChatoutPage(): React.ReactElement {
  const [text, setText] = React.useState('中路没眼，等我一下')
  const [tone, setTone] = React.useState('calm')
  const [cross, setCross] = React.useState(true)
  const [phrases, setPhrases] = React.useState(PHRASES)
  const [justSent, setJustSent] = React.useState(false)

  return (
    <div>
      <Card>
        <SectionTitle note="这里只预演一次：真正的发送是在游戏里按 Alt+Shift+T，抓你正在打的草稿。">
          文字出口
        </SectionTitle>
        <Row
          stacked
          label="原地直发"
          hint="Alt+Shift+T"
          note="读你在游戏聊天框里已经打出来（还没发）的中文 → 翻译 → 贴回去 → 回车。不注入、不改游戏文件。"
          control={
            <div style={{ display: 'grid', gap: 6 }}>
              <input
                value={text}
                onChange={(e) => setText(e.target.value)}
                style={{
                  background: C.card2,
                  border: `1px solid ${C.line2}`,
                  borderRadius: 7,
                  color: C.text,
                  fontSize: FS.body,
                  padding: '6px 9px',
                  fontFamily: 'inherit'
                }}
              />
              <div style={{ fontSize: FS.small, color: C.dim }}>
                会发出：<span style={{ color: C.text }}>Mid has no wards, wait for me</span>
              </div>
            </div>
          }
        />
        <Row
          label="现在就发"
          hint="不用进游戏"
          note="用同一个翻译会话发一次，只写进「最近直发」，不会碰游戏窗口。"
          control={
            <Btn
              primary
              onClick={() => {
                setJustSent(true)
                window.setTimeout(() => setJustSent(false), 1600)
              }}
            >
              {justSent ? '已发出 ✓' : '现在就发'}
            </Btn>
          }
        />
        <Row
          stacked
          label="语气"
          hint="多花一次模型调用"
          control={
            <Chips
              value={tone}
              onChange={setTone}
              options={[
                { id: 'calm', label: '平静' },
                { id: 'urgent', label: '紧迫' },
                { id: 'banter', label: '嘴炮' }
              ]}
            />
          }
          note="语气只改词不改进攻性：不会替你骂人，也不会把「买活」翻译成一段话。"
          last
        />
      </Card>

      <Card>
        <SectionTitle note="每种语气各自一份词库与历史，混用会让同一个词前后翻成两种说法。">
          语气
        </SectionTitle>
        <Row
          label="默认语气"
          note="开局那句话用这个；局内临时改只影响那一次。"
          control={
            <SelectBox
              value={tone}
              onChange={setTone}
              width={170}
              options={[
                { id: 'calm', label: '平静（默认）' },
                { id: 'urgent', label: '紧迫' },
                { id: 'banter', label: '嘴炮' }
              ]}
            />
          }
        />
        <Row
          label="跨语气查词库"
          note="开着时，「买活」在任何语气下都沿用你已经确认过的译法。关掉就完全隔离。"
          control={<Toggle on={cross} onChange={setCross} label={cross ? '开' : '关'} />}
          last
        />
      </Card>

      <Card>
        <SectionTitle note="浮层呼出面板里点一下就复制到剪贴板；这里管内容本身。">
          快捷短语
        </SectionTitle>
        <Row
          label="短语分组"
          hint="组名在手填 · 无编辑器"
          note="组名可以为空，空组不显示。这三个变量在短语里直接写就有：{hero} / {time} / {matchid} —— 例如「{hero} 说：{time}，团战别追」。"
          control={<Pill tone="warn">待定</Pill>}
        />
        {phrases.map((p, i) => (
          <Row
            key={p.id}
            label={p.zh}
            hint={p.tone}
            note={p.en}
            last={i === phrases.length - 1 && phrases.length > 0}
            control={
              <Btn
                small
                onClick={() => setPhrases((prev) => prev.filter((x) => x.id !== p.id))}
                title="从列表里删掉这条"
              >
                删
              </Btn>
            }
          />
        ))}
        <div style={{ marginTop: 10, display: 'flex', gap: 6 }}>
          <Btn
            small
            onClick={() =>
              setPhrases((prev) => [
                ...prev,
                { id: `p${prev.length + 1}`, zh: '新短语', en: 'New phrase', tone: '平静' }
              ])
            }
          >
            加一条
          </Btn>
          <span style={{ fontSize: FS.small, color: C.dim }}>
            上限 20 条，超了会挡住新增并说出来，不会静默丢。
          </span>
        </div>
      </Card>

      <Card>
        <SectionTitle>最近直发</SectionTitle>
        <Table
          head={['时间', '原文', '发出', '结果']}
          rows={[
            ['12:06:51', '中路没眼', 'No vision mid', <Pill tone="ok">已粘贴</Pill>],
            ['12:04:02', '他们开雾了', 'They smoked', <Pill tone="ok">已粘贴</Pill>],
            ['12:01:33', 'gg', 'gg', <Pill tone="warn">未粘贴（焦点丢了）</Pill>]
          ]}
        />
      </Card>

      <Banner tone="info" title="它按下的只有 Ctrl+A / Ctrl+V / Enter">
        游戏聊天框接受注入的按键，Source 2 的控制台不接受任何形式的粘贴 —— 这两件事不要互相推论。
      </Banner>
      <div style={{ fontSize: FS.small, color: C.dim, fontFamily: MONO }}>
        settings: replyTone · crossToneLookup · quickPhrases
      </div>
    </div>
  )
}
