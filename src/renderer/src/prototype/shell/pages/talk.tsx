/**
 * 它怎么听 · 说（原「说话」页，21 个设置行 → 10 行 + 一句指向抽屉）。
 *
 * v3 的口径：对局中要改的四件事（设备、引擎、音色、语速）已经在驾驶室的
 * 「说与听」抽屉里；这一页只留「开赛前要定、对局中不会碰」的东西。
 * 任何一行如果抽屉里也有，就必须删掉 —— 两处写同一个设置是漂移的起点。
 */
import * as React from 'react'

import {
  Bar,
  Btn,
  Card,
  Chips,
  KV,
  Pill,
  Row,
  SectionTitle,
  SelectBox,
  Table,
  Toggle
} from '../kit'
import { C, FS, MONO } from '../tokens'

/** 模拟一个一直在动的麦克风电平：真实实现来自 getUserMedia 的 analyser。 */
function useMeter(active: boolean): number {
  const [v, setV] = React.useState(0.18)
  React.useEffect(() => {
    const timer = window.setInterval(() => {
      setV(active ? 0.35 + Math.random() * 0.5 : 0.08 + Math.random() * 0.12)
    }, 160)
    return () => window.clearInterval(timer)
  }, [active])
  return v
}

const RECORDS: string[][] = [
  ['18:41', 'Gank mid, wait for me', '2 句 · 1.8 s', 'edge', '✓'],
  ['18:36', 'They smoked, back off', '1 句 · 1.2 s', 'edge', '✓'],
  ['18:30', 'Buyback in 20', '2 句 · 2.4 s', 'sovits', '✓'],
  ['18:22', '—（识别为空）', '0 句', '—', '✕']
]

export function TalkPage(): React.ReactElement {
  const [mic, setMic] = React.useState('array')
  const [holding, setHolding] = React.useState(false)
  const meter = useMeter(holding)
  const [engine, setEngine] = React.useState('edge')
  const [outDevice, setOutDevice] = React.useState('cable')
  const [cableOk, setCableOk] = React.useState(false)
  const [monitor, setMonitor] = React.useState(false)
  const [interpret, setInterpret] = React.useState(false)
  const [voiceOutTest, setVoiceOutTest] = React.useState(false)
  const [asrModel, setAsrModel] = React.useState('qwen3')
  const [shadow, setShadow] = React.useState(true)
  const [split, setSplit] = React.useState('punct')

  return (
    <>
      <Card>
        <SectionTitle note="这条腿是「你说、别人听」。反方向（别人打字、念给你听）在「它怎么念」。">
          听与说
        </SectionTitle>
        <Row
          label="设备、引擎、音色、语速"
          hint="这四个对局中也会改，所以它们只在驾驶室的「说与听」抽屉里出现一次"
          last
          control={<Pill tone="ok">抽屉里 6 项</Pill>}
        />
      </Card>

      <Card>
        <SectionTitle note="麦克风只在按住热键时打开，松手就关；识别模型常驻内存，掉线自动重拉。">
          听 · 你说话
        </SectionTitle>
        <Row
          stacked
          label="麦克风电平"
          note="按住下面的按钮看电平；真机上按住热键时同一个表在动"
          control={
            <>
              <Btn small onClick={() => setHolding(true)}>
                按住
              </Btn>
              <Btn small onClick={() => setHolding(false)}>
                松开
              </Btn>
            </>
          }
        />
        <Bar value={meter} label={`输入电平 ${Math.round(meter * 100)}%`} />
        <Row
          stacked
          label="讲话设备"
          hint="选到虚拟声卡等于让自己听自己"
          note={
            mic === 'cable'
              ? '⚠ 现在选的是 CABLE Output：你说话时会把游戏的声音也收进来'
              : '默认跟随系统；换了设备下一句生效'
          }
          noteTone={mic === 'cable' ? 'warn' : 'dim'}
          control={
            <SelectBox
              options={[
                { id: 'array', label: '麦克风阵列（Realtek）' },
                { id: 'cable', label: 'CABLE Output（虚拟）' }
              ]}
              value={mic}
              onChange={setMic}
            />
          }
        />
        <Row
          stacked
          label="热词"
          hint="49 / 50"
          note="这些词优先认对：英雄名、你的 ID、队内黑话。满了要删一个才能加新的 —— 不会替你丢。"
          control={
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {['肉山', '智慧符', '开雾', '买活', '跳刀', '拉野', '叠野', '分身'].map((word) => (
                <Pill key={word}>{word}</Pill>
              ))}
              <Btn small>编辑</Btn>
            </div>
          }
        />
        <Row
          label="不念谁"
          hint="按人不按队"
          note="只影响「念给你听」这一条腿：关掉的人说了什么照常记进历史，只是不出声。"
          control={
            <div style={{ display: 'flex', gap: 6 }}>
              <Pill tone="warn">对面 5 人</Pill>
              <Btn small>改名单</Btn>
            </div>
          }
        />
        <Row
          label="识别模型"
          hint="换模型会重载识别器"
          last
          control={
            <SelectBox
              options={[
                { id: 'qwen3', label: 'Qwen3-ASR 0.6B · 799 MB' },
                { id: 'paraformer', label: 'Paraformer · 240 MB' }
              ]}
              value={asrModel}
              onChange={setAsrModel}
            />
          }
        />
      </Card>

      <Card>
        <SectionTitle note="这一条把英文念进游戏的语音通道，所以要一块虚拟声卡把「应用的声音」伪装成「麦克风」。">
          说 · 队友听到的
        </SectionTitle>
        <Row
          label="合成引擎"
          control={
            <SelectBox
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
          label="输出设备"
          hint="念给游戏听的那一路；选成扬声器就等于公放"
          note={
            cableOk
              ? 'CABLE Input（VB-Audio Virtual Cable）· 已就绪，队友能听见'
              : '驱动已装，但设备清单里还没出现 CABLE Input：点「重新检测」；还是没有就重启一次电脑'
          }
          noteTone={cableOk ? 'dim' : 'warn'}
          control={
            <>
              <SelectBox
                options={[
                  { id: 'cable', label: 'CABLE Input（虚拟）' },
                  { id: 'speaker', label: '扬声器（Realtek）' }
                ]}
                value={outDevice}
                onChange={setOutDevice}
              />
              <Pill tone={cableOk ? 'ok' : 'warn'}>{cableOk ? '已就绪' : '缺端点'}</Pill>
              <Btn small onClick={() => setCableOk(true)}>
                重新检测
              </Btn>
            </>
          }
        />
        <Row
          label="本机也播放一份"
          hint="开着会在耳机里听到合成结果；用虚拟声卡时通常关掉"
          control={<Toggle on={monitor} onChange={setMonitor} />}
        />
        <Row
          label="同声翻译"
          hint="队友说英语、你说中文时互相转译；关掉就只做单向"
          last
          control={<Toggle on={interpret} onChange={setInterpret} />}
        />
      </Card>

      <Card>
        <SectionTitle note="按顺序念，不插队：上一句没念完，下一句等着。">队列与记录</SectionTitle>
        <Row
          stacked
          label="正在念"
          note="Gank mid, wait for me（3 句中的第 1 句）"
          control={<Pill tone="ok">在念</Pill>}
        />
        <Row label="排队" note="They smoked · Buyback" control={<Pill>2 句</Pill>} />
        <Row
          label="测试模式"
          hint="只验证「念得出来」，不验证「游戏能不能听见」"
          control={<Toggle on={voiceOutTest} onChange={setVoiceOutTest} />}
        />
        <Row
          stacked
          label="上一轮耗时"
          note="识别 640 ms · 翻译 1.1 s · 合成 480 ms · 起播 2.2 s"
          last
          control={<Pill>中位 1.8 s</Pill>}
        />
      </Card>

      <Card>
        <SectionTitle note="每一行都是真的说过的一句；✕ 表示那一段没测到，不是 0。">
          识别记录
        </SectionTitle>
        <Table head={['时间', '说了什么', '段数 · 耗时', '引擎', '结果']} rows={RECORDS} />
        <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
          <Btn small>导出这一局</Btn>
          <Btn small>看完整日志</Btn>
        </div>
      </Card>

      <Card>
        <SectionTitle note="这三项决定「这一整局要不要真的出声」；改一次，整局都按新规则走。">
          影子模式与切段
        </SectionTitle>
        <Row
          label="影子模式"
          hint="默认开 · 打完一局自动结束"
          note="开着时只记账不动嘴：识别、翻译、计时都照跑，一行都不念。一局结束自己关掉，不用你手动关。"
          control={<Toggle on={shadow} onChange={setShadow} label={shadow ? '开' : '关'} />}
        />
        <Row
          label="切段策略"
          hint="按标点 / 按字数"
          note="按标点是默认：逗号句号处断开，念起来像人；按字数是等长切，只在标点断得太碎时用。"
          control={
            <Chips
              value={split}
              onChange={setSplit}
              options={[
                { id: 'punct', label: '按标点' },
                { id: 'even', label: '按字数' }
              ]}
            />
          }
        />
        <Row
          label="这条链走到哪"
          note="识别完了 / 翻译回来了 / 已经出声：三段各占多久。某一段明显变长，就是那一段该查了。"
          last
          control={<Pill tone="ok">三段都在跑</Pill>}
        />
      </Card>

      <div style={{ fontSize: FS.mini, color: C.dim, lineHeight: 1.7, paddingLeft: 2 }}>
        这一页只管「开赛前定下来」。对局中要改语速、换音色、关掉某个人，都在驾驶室里：
        <span style={{ fontFamily: MONO, color: C.text }}> 大点声 / 换个声音 / 关掉老张</span>。
      </div>

      <KV
        columns={2}
        items={[
          ['输入设备 id', 'default|a1b2c3d4'],
          ['输出设备 id', 'cable|e5f6g7h8']
        ]}
      />
    </>
  )
}
