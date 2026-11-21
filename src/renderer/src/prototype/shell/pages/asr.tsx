/**
 * 识别训练：环境 / 数据 / 训练 / 现役 四步，头上一条状态说「你现在在哪、下一步该按哪个」。
 *
 * 只有头上那条是行动入口；其余每个操作都留在它自己那一步里。这样一进来就不会有三种按钮抢注意力。
 */
import * as React from 'react'

import {
  Banner,
  Bar,
  Btn,
  Card,
  Chips,
  KV,
  Pill,
  Row,
  SectionTitle,
  Slider,
  Table,
  Toggle
} from '../kit'
import { C, FS, MONO } from '../tokens'

const STEPS = [
  { id: 'env', label: '环境' },
  { id: 'data', label: '数据' },
  { id: 'train', label: '训练' },
  { id: 'live', label: '现役' }
] as const

type Step = (typeof STEPS)[number]['id']
type State = 'env' | 'data' | 'ready' | 'running' | 'live' | 'failed'

const HEADLINE: Record<
  State,
  { title: string; tone: 'ok' | 'warn' | 'bad' | 'idle'; note: string; action: string }
> = {
  env: {
    title: '缺环境',
    tone: 'bad',
    note: 'Python 3.11 与 torch 都在，但还缺 2 个依赖。装完就能开训。',
    action: '安装依赖'
  },
  data: {
    title: '数据不足',
    tone: 'warn',
    note: '账本里只有 12 条可用，开训至少要 40 条；先去「数据」把那 8 句补录完。',
    action: '去录音'
  },
  ready: {
    title: '可开训',
    tone: 'ok',
    note: '48 条数据、环境齐、底模副本在位；全量或增量都行。',
    action: '开始训练'
  },
  running: {
    title: '训练中',
    tone: 'warn',
    note: '第 4 / 12 个 epoch，预计还要 26 分钟。这期间不要关应用。',
    action: '看日志'
  },
  live: {
    title: '现役',
    tone: 'ok',
    note: 'qwen3-0.6b-ft-1121 正在被语音对讲使用；上一代留在 .bak 里可回滚。',
    action: '试听对比'
  },
  failed: {
    title: '上次失败',
    tone: 'bad',
    note: '显存不足（OOM at step 312）：把批次调小，或换「增量」。',
    action: '看原因'
  }
}

export function AsrPage(): React.ReactElement {
  const [step, setStep] = React.useState<Step>('train')
  const [state, setState] = React.useState<State>('env')
  const [batch, setBatch] = React.useState(8)
  const [kind, setKind] = React.useState<'full' | 'incr'>('incr')
  const [busy, setBusy] = React.useState('')
  const [route, setRoute] = React.useState(false)
  const [correct, setCorrect] = React.useState(true)

  const head = HEADLINE[state]
  const act = (): void => {
    if (state === 'env') {
      setBusy('装依赖…')
      window.setTimeout(() => {
        setBusy('')
        setState('data')
      }, 1100)
      return
    }
    if (state === 'data') {
      setStep('data')
      setState('ready')
      return
    }
    if (state === 'ready' || state === 'failed') {
      setState('running')
      setBusy('')
      window.setTimeout(() => setState('live'), 2600)
      return
    }
    if (state === 'running') setStep('live')
  }

  return (
    <div>
      <Card>
        <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 10 }}>
          <span style={{ fontSize: 17, fontWeight: 650 }}>{head.title}</span>
          <Pill tone={head.tone}>
            {state === 'live' ? '在用' : state === 'running' ? '运行中' : '待处理'}
          </Pill>
          <span
            style={{
              flex: '1 1 12rem',
              minWidth: 0,
              fontSize: FS.small,
              color: C.dim,
              lineHeight: 1.6
            }}
          >
            {head.note}
          </span>
          <Btn primary small onClick={act} disabled={busy === '装依赖…'}>
            {busy || head.action}
          </Btn>
        </div>
      </Card>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '132px minmax(0, 1fr)',
          gap: 12,
          alignItems: 'start'
        }}
      >
        <Card pad={8}>
          {STEPS.map((s) => {
            const on = s.id === step
            return (
              <button
                key={s.id}
                type="button"
                onClick={() => setStep(s.id)}
                style={{
                  display: 'block',
                  width: '100%',
                  textAlign: 'left',
                  background: on ? `${C.accent}14` : 'transparent',
                  color: on ? C.accent : C.dim,
                  border: 'none',
                  borderLeft: `2px solid ${on ? C.accent : 'transparent'}`,
                  padding: '7px 9px',
                  fontSize: FS.body,
                  cursor: 'pointer'
                }}
              >
                {s.label}
              </button>
            )
          })}
        </Card>

        <div>
          {step === 'env' ? (
            <Card>
              <SectionTitle note="这一层只检查「能不能跑」，不修环境：装什么、缺什么都在这里说清楚。">
                环境
              </SectionTitle>
              <Row
                stacked
                label="Python 与依赖"
                control={
                  <KV
                    items={[
                      ['python', '3.11.9'],
                      ['torch', '2.4.1+cu121'],
                      ['funasr', '1.1.12'],
                      ['onnx', '1.17.0']
                    ]}
                    columns={2}
                  />
                }
              />
              <Row
                label="还缺的依赖"
                hint="缺什么写什么"
                note="当前什么都齐。缺的时候这一行会说清是哪一条：缺 funasr 就训练起不来，缺 onnxruntime 就导出不了，缺 CUDA 就只能上 CPU（慢 8 倍）。"
                control={<Pill tone="ok">齐了</Pill>}
              />
              <Row
                label="底模副本"
                note="每个引擎一份不可变底模，重置为底模时从这里拷，不重新下载。"
                control={<Pill tone="ok">qwen3-base 8.4 GB</Pill>}
                last
              />
            </Card>
          ) : null}
          {step === 'data' ? (
            <Card>
              <SectionTitle note="录一句、校一句。纠对的那一行会写回账本 —— 它同时是训练标签和下一次的答案键。">
                数据
              </SectionTitle>
              <Row
                label="录音组"
                hint="4 组 · 78 条"
                note="G01 对线 24 条 · G02 团战 21 条 · G03 打野 18 条 · G99 自定义 15 条。G99 是你自己写句子再录的那组，不用等别人排稿。"
                control={<Pill tone="ok">账本一致</Pill>}
              />
              <Row
                label="读稿"
                hint="G01–G09 分组"
                control={
                  <Chips
                    value="g1"
                    onChange={() => undefined}
                    options={[
                      { id: 'g1', label: 'G01 对线' },
                      { id: 'g2', label: 'G02 团战' },
                      { id: 'g3', label: 'G99 自定义' }
                    ]}
                  />
                }
              />
              <Row
                stacked
                label="句子"
                control={
                  <span style={{ fontSize: FS.body, color: C.text }}>「他们开雾了，中路小心」</span>
                }
              />
              <Row
                label="录音"
                hint="按住空格"
                control={
                  <>
                    <Btn small>录这一句</Btn>
                    <Btn small>跳过</Btn>
                  </>
                }
                note="录完立刻回放识别结果；不对就当场改，改完的那一行才算可用数据。"
              />
              <Row
                label="识别结果"
                note="他们开误了，中路小心（错 1 字）"
                control={<Pill tone="warn">需纠错</Pill>}
              />
              <Row
                label="纠错样本"
                hint="改对的句子留成训练数据"
                note="默认开：它不改任何现有行为，只是把「你改过的那一行」多存一份"
                control={<Toggle on={correct} onChange={setCorrect} />}
              />
              <Row
                stacked
                label="数据体检"
                control={<Bar value={0.62} label="48 / 78 条可用 · 账本一致 · 无重复 clip" />}
              />
              <Row
                stacked
                label="全量识别比对"
                hint="测一遍"
                control={
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Btn small>跑一遍</Btn>
                    <span style={{ fontSize: FS.small, color: C.dim }}>
                      最近一次 CER：train 4.1% · eval 7.8%
                    </span>
                  </div>
                }
                last
              />
            </Card>
          ) : null}
          {step === 'train' ? (
            <Card>
              <SectionTitle note="全量 = 从底模重训所有数据；增量 = 从上一个微调模型继续，只吃没被训练吃过的录音。">
                训练
              </SectionTitle>
              <Row
                label="训练目标"
                hint="只有现役引擎能训"
                note="qwen3 · Qwen3-ASR-1.7B-int8 · 17 层。要训另一个引擎，先把它切到现役，否则这一页一直在训 qwen3。"
                control={<Pill tone="ok">qwen3</Pill>}
              />
              <Row
                label="待训数据"
                hint="48 条"
                note="其中 11 条是上一轮之后新录的，增量只吃这 11 条。"
                control={<Pill tone="ok">已打包</Pill>}
              />
              <Row
                label="开训方式"
                control={
                  <Chips
                    value={kind}
                    onChange={setKind}
                    options={[
                      { id: 'incr', label: '增量' },
                      { id: 'full', label: '全量' }
                    ]}
                  />
                }
                note={
                  kind === 'incr'
                    ? '从上一次成功的产物继续，约 20 分钟。'
                    : '从底模重来，约 70 分钟；重训之前确认上一代权重已改名。'
                }
              />
              <Row
                stacked
                label="批次"
                hint="显存不够就调小"
                control={
                  <Slider value={batch} min={1} max={8} step={1} onChange={setBatch} suffix=" 条" />
                }
              />
              <Row
                stacked
                label="预计耗时"
                note={
                  busy === '装依赖…'
                    ? undefined
                    : '按当前批次与数据量估算；训练期间关应用会留下一条 failed 记录，下次启动自动收尾。'
                }
                control={
                  <Bar
                    value={state === 'running' ? 0.34 : 0}
                    label={state === 'running' ? '第 4 / 12 epoch · 约 26 分钟' : '还没开始'}
                  />
                }
              />
              <Row
                label="开训"
                control={
                  <Btn
                    primary
                    onClick={() => (state === 'running' ? setState('live') : setState('running'))}
                    disabled={state === 'env'}
                  >
                    {state === 'running' ? '结束（演示）' : '开始训练'}
                  </Btn>
                }
              />
              <Row
                stacked
                label="训练记录"
                control={
                  <Table
                    head={['开始', '方式', '数据', '结局']}
                    rows={[
                      ['11-21 03:12', '增量', '11 条', <Pill tone="warn">训练中</Pill>],
                      ['11-20 22:40', '全量', '37 条', <Pill tone="ok">成功</Pill>],
                      ['11-20 19:02', '增量', '6 条', <Pill tone="bad">失败</Pill>]
                    ]}
                  />
                }
                last
              />
            </Card>
          ) : null}
          {step === 'live' ? (
            <Card>
              <SectionTitle note="这一块回答「现在用的是哪一个、什么时候换的、能不能退回去」。">
                现役
              </SectionTitle>
              <Row
                label="生效模型"
                note="训练成功后自动切换；换模型会重载识别器（约 1.4 s，下一次说话时才发生）。"
                control={<Pill tone="ok">qwen3-0.6b-ft-1121</Pill>}
              />
              <Row
                stacked
                label="试听对比"
                hint="同一段录音跑两遍"
                control={
                  <div style={{ display: 'flex', gap: 6 }}>
                    <Btn small>当前</Btn>
                    <Btn small>上一代（.bak）</Btn>
                  </div>
                }
              />
              <Row
                stacked
                label="试听"
                control={
                  <div style={{ display: 'flex', gap: 6 }}>
                    <span style={{ fontSize: FS.small, color: C.dim }}>
                      当前：他们开雾了，中路小心
                    </span>
                    <span style={{ fontSize: FS.small, color: C.dim }}>
                      · 上一代：他们开误了 中路小心
                    </span>
                  </div>
                }
              />
              <Row
                label="短句 / 长句分流"
                note="短句走 paraformer（快）、长句走 qwen3（准）。两副模型都加载，内存会涨约 700 MB。"
                control={<Toggle on={route} onChange={setRoute} label={route ? '开' : '关'} />}
              />
              <Row
                label="最近导出"
                note="导出失败的那一次没留下半成品：先写 .next 再改名。"
                control={<Pill tone="ok">onnx + tokens.txt 齐</Pill>}
              />
              <Row
                label="换模"
                note="换成另一个引擎的已训模型；底模副本不动，随时可以重置回来。"
                control={<Btn small>换一个</Btn>}
              />
              <Row label="旧的微调模型" hint=".bak" control={<Btn small>回滚到上一代</Btn>} last />
            </Card>
          ) : null}
        </div>
      </div>

      <div style={{ height: 10 }} />
      <SectionTitle note="最近一次训练留下的三条结论，读日志得到，不是猜的。">
        最近训练
      </SectionTitle>
      <Card>
        <Row
          label="结局"
          note="成功 · 12 epoch · 26 分 14 秒"
          control={<Pill tone="ok">成功</Pill>}
        />
        <Row
          label="指标"
          note="eval CER 7.8%（比上一代降 1.2 个点）"
          control={<Pill tone="ok">变好</Pill>}
        />
        <Row
          label="产物"
          note="asr-ft-runs/ft-20261121-0312（已提升为现役，旧目录已清理）"
          control={
            <span style={{ fontFamily: MONO, fontSize: FS.small, color: C.dim }}>15.2 GB</span>
          }
          last
        />
      </Card>
      {state === 'failed' ? (
        <Banner tone="bad" title="上次失败：显存不足">
          把批次调到 4 再试一次；仍然 OOM 就改用「增量」。
        </Banner>
      ) : null}
      <div style={{ fontSize: FS.small, color: C.dim, lineHeight: 1.7 }}>
        收起来的四项并进了相邻的行：缺哪个依赖看「Python 与依赖」，纠错样本看「识别结果」，
        打包数据集在「待训数据」旁边，批次在「开训」里跟着显存建议走 —— 同一件事只留一个入口。
      </div>
      <div style={{ fontSize: FS.small, color: C.dim, fontFamily: MONO }}>
        这一页的开关只会写到 settings 的 asrActiveModel / asrTrainEngine / asrRouteShortLong
      </div>
      <div style={{ height: 4 }} />
    </div>
  )
}
