/**
 * 总览：四件事「现在通不通」＋「哪里坏了」＋「这台机器够不够」。
 *
 * 这一页回答的问题只有一个：**现在能不能开局，不能的话卡在哪一环**。
 * 所以顺序是固定的：先四条链路，再异常，再体检，最后才是上手动作。
 */
import * as React from 'react'

import { Banner, Bar, Btn, Card, KV, Pill, Row, SectionTitle, SelectBox, Toggle } from '../kit'
import { C, FS, MONO } from '../tokens'

/** 四条链路：模型服务 → 对局正文（GSI）→ 翻译 → 浮层。 */
const LINKS = [
  {
    name: '模型服务',
    value: 'DeepSeek · 412 ms',
    tone: 'ok' as const,
    note: '连通性最近一次：12:04:11'
  },
  {
    name: '对局正文',
    value: 'GSI · 静默 34 s',
    tone: 'warn' as const,
    note: '上一帧 12:07:02，超过 90 秒没帧就会写断流诊断'
  },
  {
    name: '浮层',
    value: '显示中 · 已锁定',
    tone: 'ok' as const,
    note: '420×132，Alt+Shift+P 解锁'
  },
  {
    name: '翻译延迟',
    value: '中位 1.8 s · P95 3.4 s',
    tone: 'ok' as const,
    note: '最近 200 条，记账本里可查单条'
  }
]

/** 这台机器：六行体检。测不到就写测不到 + 原因，不许亮绿。 */
const MACHINE = [
  { label: '麦克风', value: '3 个输入', tone: 'ok' as const, why: '' },
  { label: '扬声器', value: '4 个输出', tone: 'ok' as const, why: '' },
  { label: '虚拟声卡', value: '端点已就绪', tone: 'ok' as const, why: '' },
  { label: 'Python 训练环境', value: '3.11 · torch 2.4', tone: 'ok' as const, why: '' },
  {
    label: '显存',
    value: '12 GB（训练建议 ≥ 16 GB）',
    tone: 'warn' as const,
    why: '全量微调会先提示，不会直接卡死'
  },
  { label: 'GSI 端口 32123', value: '本应用占着', tone: 'ok' as const, why: '' }
]

const CHECKS = [
  { id: 'gsi', text: '游戏里已生成 cfg，并重启过一次 Dota', done: true },
  { id: 'mic', text: '麦克风不是被虚拟声卡顶掉的那个', done: true },
  { id: 'out', text: '出声设备与游戏输出是同一个耳机', done: true },
  { id: 'key', text: '说话键与游戏内语音键不冲突', done: false },
  { id: 'trial', text: '在这儿试说过一句，整条链走过一遍', done: false }
]

/** 代码适配：游戏发来的东西里，哪些真的到过。 */
const ADAPT = [
  ['chat_message', '到过 · 最近 12:07:02'],
  ['allplayers', '到过 · 只在观战/录像里有'],
  ['draft', '从没到过 · 选人阶段数据可能不存在'],
  ['minimap', '不支持 · 不做注入'],
  ['游戏发来了新东西', '7.39c 已适配 · 最近一次 3 天前']
]

export function OverviewPage(): React.ReactElement {
  const [checks, setChecks] = React.useState(CHECKS)
  const [library, setLibrary] = React.useState('auto')
  const [probing, setProbing] = React.useState(false)
  const [machine, setMachine] = React.useState(MACHINE)
  const [stall, setStall] = React.useState(true)
  const done = checks.filter((c) => c.done).length

  const recheck = (): void => {
    setProbing(true)
    window.setTimeout(() => {
      setProbing(false)
      setMachine((prev) =>
        prev.map((row) =>
          row.label === '虚拟声卡' && row.tone !== 'ok'
            ? { ...row, value: '端点已就绪', tone: 'ok' as const, why: '' }
            : row
        )
      )
    }, 900)
  }

  return (
    <div>
      <Card>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontSize: 17, fontWeight: 650 }}>四条链路 3/4 通</span>
          <Pill tone="warn">对局正文静默</Pill>
          <span style={{ flex: '1 1 10rem' }} />
          <Btn small onClick={recheck} disabled={probing}>
            {probing ? '检测中…' : '重新体检'}
          </Btn>
        </div>
        <div style={{ marginTop: 10 }}>
          {LINKS.map((l) => (
            <Row
              key={l.name}
              label={l.name}
              note={l.note}
              control={
                <>
                  <span style={{ fontFamily: MONO, fontSize: FS.small, color: C.dim }}>
                    {l.value}
                  </span>
                  <Pill tone={l.tone}>{l.tone === 'ok' ? '通' : '慢'}</Pill>
                </>
              }
            />
          ))}
        </div>
      </Card>

      <SectionTitle note="只有这里列出来的才是真的坏了；一行只放一个原因和一条出路。">
        异常
      </SectionTitle>
      {stall ? (
        <Banner
          tone="warn"
          title="GSI 断流 · 已静默 34 秒"
          action={
            <Btn small onClick={() => setStall(false)}>
              我已重启 Dota
            </Btn>
          }
        >
          Dota 只在启动时读一次 cfg，游戏里没法重载 —— 请重启 Dota；这行会在下一帧到达时自己消失。
        </Banner>
      ) : (
        <Banner tone="info" title="GSI 正在收帧">
          停止诊断标记等下一帧到达后自动清理。
        </Banner>
      )}
      <Card>
        <Row
          label="会话层回退直连"
          hint="出现 1 次"
          note="代理连不上时自动直连，只影响那一轮；不需要处理。"
          control={<Pill tone="ok">已回退</Pill>}
        />
        <Row
          label="对局正文报错"
          note="没有未处理的报错。"
          control={<Pill tone="ok">无</Pill>}
          last
        />
      </Card>

      <SectionTitle
        note={`${done}/${checks.length} 项做完。每一条都对应一次真实踩坑，不看就直接开局多半会卡在第一步。`}
      >
        上手检查
      </SectionTitle>
      <Card>
        {checks.map((c, i) => (
          <Row
            key={c.id}
            label={c.text}
            last={i === checks.length - 1}
            control={
              <Toggle
                on={c.done}
                onChange={(next) =>
                  setChecks((prev) => prev.map((x) => (x.id === c.id ? { ...x, done: next } : x)))
                }
                label={c.done ? '已做' : '未做'}
              />
            }
          />
        ))}
        <div style={{ marginTop: 10 }}>
          <Bar
            value={done / checks.length}
            label={`${Math.round((done / checks.length) * 100)}% · 剩下两项都是需要你亲自听一遍的`}
          />
        </div>
      </Card>

      <SectionTitle note="游戏发来的东西里，哪些真的到过这台机器。没到过的功能不该假装能用。">
        代码适配
      </SectionTitle>
      <Card>
        {ADAPT.map(([k, v], i) => (
          <Row
            key={k}
            label={k}
            note={v}
            noteTone={v.startsWith('从没到过') ? 'warn' : v.startsWith('不支持') ? 'bad' : 'dim'}
            last={i === ADAPT.length - 1}
          />
        ))}
      </Card>

      <SectionTitle note="六行里有一行测不到就写「测不到 + 原因」，不许亮绿。">
        这台机器
      </SectionTitle>
      <Card>
        {machine.map((row) => (
          <Row
            key={row.label}
            label={row.label}
            note={row.why || undefined}
            noteTone={row.tone === 'warn' ? 'warn' : 'dim'}
            control={
              <>
                <span style={{ fontSize: FS.small, color: C.dim }}>{row.value}</span>
                <Pill tone={row.tone}>{row.tone === 'ok' ? '有数据' : '注意'}</Pill>
              </>
            }
          />
        ))}
        <Row
          label="Steam 库"
          note="换库之后要重启游戏才生效：Dota 只在启动时读一次 cfg。"
          control={
            <>
              <SelectBox
                value={library}
                onChange={setLibrary}
                options={[
                  { id: 'auto', label: '自动（G:）' },
                  { id: 'g', label: 'G:\\SteamLibrary' },
                  { id: 'd', label: 'D:\\SteamLibrary' }
                ]}
              />
              <Btn small>用这个库</Btn>
            </>
          }
          last
        />
      </Card>

      <SectionTitle>热键一览</SectionTitle>
      <Card>
        <KV
          columns={2}
          items={[
            ['显示/隐藏', 'Alt+Shift+O'],
            ['锁定', 'Alt+Shift+P'],
            ['收起', 'Alt+Shift+B'],
            ['原地直发', 'Alt+Shift+T'],
            ['呼出面板', 'Alt+Shift+H'],
            ['看一眼画面', 'Alt+Shift+G'],
            ['语音对讲', 'Alt+Shift+V']
          ]}
        />
      </Card>
    </div>
  )
}
