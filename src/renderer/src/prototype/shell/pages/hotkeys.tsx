/**
 * 热键：七条动作键位 + 两件只有这一页能回答的事（按住到底还灵不灵、这条键是不是被别人占了）。
 *
 * 冲突不静默丢弃：两条都标红，整表拒绝保存。热键页唯一允许的失败是「说出来」。
 */
import * as React from 'react'

import { Banner, Btn, Card, Chips, Pill, Row, SectionTitle } from '../kit'
import { C, FS, MONO } from '../tokens'

type Key = { id: string; action: string; hint: string; chord: string }

const INITIAL: Key[] = [
  { id: 'overlayToggle', action: '显示 / 隐藏浮层', hint: 'Alt+Shift+O', chord: 'Alt+Shift+O' },
  { id: 'overlayLock', action: '锁定 / 解锁', hint: '锁上就鼠标穿透', chord: 'Alt+Shift+P' },
  { id: 'overlayCollapse', action: '收起成小图标', hint: '132×34', chord: 'Alt+Shift+B' },
  { id: 'inplaceSend', action: '原地直发', hint: '读草稿 → 翻译 → 贴回去', chord: 'Alt+Shift+T' },
  {
    id: 'overlayPanel',
    action: '呼出面板',
    hint: '历史 / 短语 / 建议 / 看一眼',
    chord: 'Alt+Shift+H'
  },
  { id: 'visionAsk', action: '看一眼画面', hint: '只在按下时截一帧', chord: 'Alt+Shift+G' },
  { id: 'voiceCapture', action: '语音对讲', hint: '按住说话，松开成链', chord: 'Alt+Shift+V' }
]

const CANDIDATES = [
  'Alt+Shift+O',
  'Alt+Shift+P',
  'Alt+Shift+B',
  'Alt+Shift+T',
  'Alt+Shift+H',
  'Alt+Shift+G',
  'Alt+Shift+V',
  'Alt+Shift+Y',
  'Ctrl+Alt+D'
]

export function HotkeysPage(): React.ReactElement {
  const [keys, setKeys] = React.useState(INITIAL)
  const [editing, setEditing] = React.useState('')
  const [mode, setMode] = React.useState<'hold' | 'toggle'>('hold')
  const [saved, setSaved] = React.useState(true)

  const conflict = React.useMemo(() => {
    const seen = new Map<string, string[]>()
    keys.forEach((k) => {
      if (!k.chord) return
      seen.set(k.chord, [...(seen.get(k.chord) ?? []), k.id])
    })
    const dup = new Set<string>()
    seen.forEach((ids) => ids.length > 1 && ids.forEach((id) => dup.add(id)))
    return dup
  }, [keys])

  const assign = (chord: string): void => {
    setKeys((prev) => prev.map((k) => (k.id === editing ? { ...k, chord } : k)))
    setEditing('')
    setSaved(false)
  }

  return (
    <div>
      <Card>
        <SectionTitle note="点一行，再点一个键位就换上了。两条动作永远不能共用同一个键。">
          动作键位
        </SectionTitle>
        {keys.map((k, i) => {
          const bad = conflict.has(k.id)
          const on = editing === k.id
          return (
            <Row
              key={k.id}
              label={k.action}
              hint={k.hint}
              note={
                bad ? `「${k.chord}」被另一条动作占着：两条都存不进去，换掉其中一个。` : undefined
              }
              noteTone="bad"
              last={i === keys.length - 1 && !editing}
              control={
                <>
                  <span
                    style={{
                      fontFamily: MONO,
                      fontSize: FS.small,
                      color: bad ? C.danger : on ? C.accent : C.text,
                      border: `1px solid ${bad ? C.danger : on ? C.accent : C.line2}`,
                      borderRadius: 6,
                      padding: '2px 8px'
                    }}
                  >
                    {k.chord || '（未绑定）'}
                  </span>
                  <Btn small onClick={() => setEditing(on ? '' : k.id)}>
                    {on ? '取消' : '改'}
                  </Btn>
                </>
              }
            />
          )
        })}
        {editing ? (
          <div
            style={{
              marginTop: 10,
              padding: 10,
              border: `1px solid ${C.accent}44`,
              borderRadius: 8,
              background: `${C.accent}0d`
            }}
          >
            <div style={{ fontSize: FS.small, color: C.accent, marginBottom: 6 }}>
              给「{keys.find((k) => k.id === editing)?.action}」选一个键（原型里用预设模拟按键捕获）
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {CANDIDATES.map((c) => (
                <Btn key={c} small onClick={() => assign(c)}>
                  {c}
                </Btn>
              ))}
            </div>
          </div>
        ) : null}
      </Card>

      <Card>
        <SectionTitle note="全局热键只报告「按下」，所以按住模式靠一个常驻脚本每 40 ms 轮询；它挂了会自动落到敲一下。">
          语音对讲怎么按
        </SectionTitle>
        <Row
          label="按住 / 敲一下"
          control={
            <Chips
              value={mode}
              onChange={setMode}
              options={[
                { id: 'hold', label: '按住' },
                { id: 'toggle', label: '敲一下' }
              ]}
            />
          }
          note={
            mode === 'hold'
              ? '按住说话，松开才走整条链；松开太早会录不到结尾。'
              : '敲一下开始、再敲一下结束；键盘连发 500 ms 内只算一次。'
          }
        />
        <Row
          stacked
          label="按住检测"
          hint="只读快照，不改任何设置"
          control={
            <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 8 }}>
              <Pill tone="ok">按住生效</Pill>
              <span style={{ fontSize: FS.small, color: C.dim }}>
                常驻脚本运行中 · 最近 24 次边沿：按下 12 / 松开 12
              </span>
            </div>
          }
          note="如果这里写的是「按住不生效」，说明现在是敲一下在用 —— 那不是设置被改了，是常驻脚本启动失败，原因在上面那行。"
        />
        <Row
          label="键位冲突"
          note={conflict.size ? `有 ${conflict.size} 条动作撞键，整表存不进去。` : '七条各不相同。'}
          noteTone={conflict.size ? 'bad' : 'ok'}
          control={
            <Pill tone={conflict.size ? 'bad' : 'ok'}>{conflict.size ? '有冲突' : '无冲突'}</Pill>
          }
          last
        />
      </Card>

      <Card>
        <SectionTitle>整表</SectionTitle>
        <Row
          label="保存热键表"
          note="保存会整表注销再注册；被别的程序占着的键会标出来，不会静默失效。"
          control={
            <>
              <Btn small onClick={() => setKeys(INITIAL)}>
                恢复默认
              </Btn>
              <Btn primary small disabled={conflict.size > 0} onClick={() => setSaved(true)}>
                {saved ? '已保存' : '保存'}
              </Btn>
            </>
          }
        />
        <Row
          label="错误"
          note={conflict.size ? '先解决冲突再保存。' : '没有注册失败。'}
          noteTone={conflict.size ? 'bad' : 'dim'}
          control={
            <Pill tone={conflict.size ? 'bad' : 'ok'}>{conflict.size ? '拒绝保存' : '无'}</Pill>
          }
          last
        />
      </Card>

      <Banner tone="info" title="浮层与暂停提示里的键名都从这张表读">
        所以任何一句给人看的文案都不许硬编码快捷键：改这里，浮层上那句提示跟着变。
      </Banner>
    </div>
  )
}
