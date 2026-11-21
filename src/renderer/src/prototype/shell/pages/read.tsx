/**
 * 它怎么念（原「听话」页，15 行 → 9 行）。
 *
 * 与 talk 页同一条规矩：语速、音色这些「对局中会改」的项只在驾驶室抽屉里，
 * 这一页留的是「开了就整局不变」的开关。
 */
import * as React from 'react'

import { Banner, Bar, Btn, Card, Chips, Pill, Row, SectionTitle, Slider, Toggle } from '../kit'
import { C, FS, MONO } from '../tokens'

type TriggerId = 'wisdom' | 'rosh' | 'stack' | 'pull'

const TRIGGERS: { id: TriggerId; label: string; note: string }[] = [
  { id: 'wisdom', label: '智慧符', note: '每 7 分钟刷一次，提前 20 秒报' },
  { id: 'rosh', label: '肉山', note: '击杀与刷新' },
  { id: 'stack', label: '叠野', note: ':53 提醒你拉一下' },
  { id: 'pull', label: '拉野', note: ':15 / :45' }
]

export function ReadPage(): React.ReactElement {
  const [readAloud, setReadAloud] = React.useState(true)
  const [ownToo, setOwnToo] = React.useState(false)
  const [announce, setAnnounce] = React.useState(false)
  const [triggers, setTriggers] = React.useState<Record<TriggerId, boolean>>({
    wisdom: true,
    rosh: true,
    stack: true,
    pull: true
  })
  const [engine, setEngine] = React.useState('edge')
  const [backlog, setBacklog] = React.useState('drop')
  const [segChars, setSegChars] = React.useState(60)
  const [tplOn, setTplOn] = React.useState(true)
  const [offline, setOffline] = React.useState<'ready' | 'downloading' | 'missing' | 'failed'>(
    'ready'
  )
  const nextOffline = (): void =>
    setOffline((was) =>
      was === 'ready' ? 'downloading' : was === 'downloading' ? 'failed' : 'missing'
    )

  return (
    <>
      <Card>
        <SectionTitle note="这条腿把别人打的字念给你听；反方向（你说、别人听）在「它怎么听 · 说」。">
          念不念、念谁
        </SectionTitle>
        <Row
          label="念出别人打的中文"
          hint="关掉之后整局都不念，包括队友的喊话"
          control={<Toggle on={readAloud} onChange={setReadAloud} />}
        />
        <Row
          label="自己的话也念一遍"
          hint="会和自己抢声；用虚拟声卡时通常关掉"
          control={<Toggle on={ownToo} onChange={setOwnToo} />}
        />
        <Row
          stacked
          label="单个队友的开关"
          note="按人的开关在对局中更常用：在驾驶室的五个频道上点一下就是关掉那个人，这里不重复放"
          last
          control={<Pill tone="ok">驾驶室里点</Pill>}
        />
      </Card>

      <Card>
        <SectionTitle note="总闸关着时，下面四条连状态机都不进 —— 不是「播报但静音」。">
          对局播报
        </SectionTitle>
        <Row
          label="对局播报"
          hint="智慧符 / 肉山 / 叠野 / 拉野 的总闸"
          control={<Toggle on={announce} onChange={setAnnounce} />}
        />
        {TRIGGERS.map((t, i) => (
          <Row
            key={t.id}
            label={t.label}
            hint={t.note}
            last={i === TRIGGERS.length - 1}
            control={
              <span style={{ opacity: announce ? 1 : 0.45 }}>
                <Toggle
                  on={triggers[t.id]}
                  onChange={(next) => setTriggers((prev) => ({ ...prev, [t.id]: next }))}
                />
              </span>
            }
          />
        ))}
      </Card>

      <Card>
        <SectionTitle note="只放「开了就整局不变」的项；语速、音色在驾驶室抽屉里。">
          嗓子
        </SectionTitle>
        <Row
          label="合成引擎"
          control={
            <SelectBoxInline
              options={[
                { id: 'edge', label: 'Edge（在线，免费）' },
                { id: 'offline', label: '离线 piper' },
                { id: 'sovits', label: 'GPT-SoVITS（本机）' }
              ]}
              value={engine}
              onChange={setEngine}
            />
          }
        />
        <Row
          stacked
          label="离线模型"
          note={
            offline === 'ready'
              ? '已就绪 · zh_CN-huayan · 63 MB。断网也能念，音质比 Edge 略差。'
              : offline === 'downloading'
                ? '下载中 · 38 / 63 MB · 关掉应用会从断点接着下'
                : offline === 'failed'
                  ? '下载失败：源站 404 · 换镜像也不行，等清单更新；已经下好的部分留着，不用重头来'
                  : '还没下过。要选「离线 piper」就得先下这一份（63 MB）。'
          }
          control={
            <>
              <Pill
                tone={
                  offline === 'ready'
                    ? 'ok'
                    : offline === 'failed'
                      ? 'bad'
                      : offline === 'downloading'
                        ? 'warn'
                        : 'idle'
                }
              >
                {offline === 'ready'
                  ? '就绪'
                  : offline === 'failed'
                    ? '失败'
                    : offline === 'downloading'
                      ? '下载中'
                      : '未下载'}
              </Pill>
              <Btn small onClick={nextOffline}>
                {offline === 'ready'
                  ? '重下'
                  : offline === 'failed'
                    ? '重试'
                    : offline === 'downloading'
                      ? '暂停'
                      : '下载 63 MB'}
              </Btn>
            </>
          }
        />
        {offline === 'downloading' ? <Bar value={0.6} tone="warn" label="38 / 63 MB" /> : null}
        <Row
          stacked
          label="刷屏怎么办"
          note="一句接一句念会把上一句打断；丢中间是默认，全念只在人少时合适"
          control={
            <Chips
              options={[
                { id: 'drop', label: '丢中间' },
                { id: 'all', label: '全念' }
              ]}
              value={backlog}
              onChange={setBacklog}
            />
          }
        />
        <Row
          stacked
          label="分句字数"
          note="长句按这个字数切开念，切点不会落在词中间"
          last
          control={
            <Slider
              value={segChars}
              min={20}
              max={120}
              step={10}
              onChange={setSegChars}
              suffix=" 字"
            />
          }
        />
        <div style={{ marginTop: 10 }}>
          <Btn small>试听一句</Btn>
        </div>
      </Card>

      <Card>
        <SectionTitle note="念的时候要不要带上说话人；模板里的 {name} {text} 是唯一变量。">
          说法模板
        </SectionTitle>
        <Row
          label="带说话人"
          hint="关掉就只念正文，听不出是谁在说"
          control={<Toggle on={tplOn} onChange={setTplOn} />}
        />
        <Row
          stacked
          label="前"
          note="念在正文前面"
          control={
            <code style={{ fontFamily: MONO, fontSize: FS.small, color: C.text }}>
              {tplOn ? '{name} 说：{text}' : '{text}'}
            </code>
          }
        />
        <Row
          stacked
          label="后"
          note="留空就不加后缀"
          last
          control={
            <code style={{ fontFamily: MONO, fontSize: FS.small, color: C.dim }}>
              （空 · 不加后缀）
            </code>
          }
        />
      </Card>

      <Banner tone="info" title="这条腿不碰游戏">
        它只读聊天、只往你的耳机念；不注入、不按键、不改游戏设置。所以它可以在任何显示模式下工作。
      </Banner>

      <div style={{ fontSize: FS.mini, color: C.dim, lineHeight: 1.7, paddingLeft: 2 }}>
        设置键：readAloud · ownToo · announceTotal · announceTriggers · ttsEngine · ttsDropBacklog ·
        ttsSpeakSegmentChars · ttsSpeakPrefix · ttsSpeakBackTpl
      </div>
    </>
  )
}

/** 只在这一页用的三选一，避免把 SelectBox 的宽度策略带进别处。 */
function SelectBoxInline({
  options,
  value,
  onChange
}: {
  options: { id: string; label: string }[]
  value: string
  onChange: (next: string) => void
}): React.ReactElement {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      style={{
        background: C.card2,
        color: C.text,
        border: `1px solid ${C.line2}`,
        borderRadius: 7,
        padding: '5px 8px',
        fontSize: FS.small
      }}
    >
      {options.map((o) => (
        <option key={o.id} value={o.id}>
          {o.label}
        </option>
      ))}
    </select>
  )
}
