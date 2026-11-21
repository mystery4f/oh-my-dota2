/**
 * 音色训练：数据 → 运行 → 产物。三块，回不去也不来回跳。
 *
 * 这一页最贵的一步不是训练，是数据准备：wav 必须全在一个平目录里，同名会被静默吞掉。
 */
import * as React from 'react'

import { Banner, Btn, Card, Chips, KV, Pill, Row, SectionTitle, Table, Toggle } from '../kit'
import { C, FS, MONO } from '../tokens'

export function VoicePage(): React.ReactElement {
  const [version, setVersion] = React.useState('zh')
  const [running, setRunning] = React.useState(false)
  const [registered, setRegistered] = React.useState<string[]>(['sovits-zh-e15'])
  const [webui, setWebui] = React.useState(false)

  const experiment = `${version === 'zh' ? 'zh' : version === 'en' ? 'en' : 'mix'}-e15`

  return (
    <div>
      <Card>
        <SectionTitle note="数据这一块是在项目外面准备的：录音、切分、标注都在 GPT-SoVITS 的目录里完成，这里只认结果。">
          数据
        </SectionTitle>
        <Row
          label="训练版本"
          hint="中文 / 英文 / 混合"
          control={
            <Chips
              value={version}
              onChange={setVersion}
              options={[
                { id: 'zh', label: '中文' },
                { id: 'en', label: '英文' },
                { id: 'mix', label: '混合' }
              ]}
            />
          }
          note={
            version === 'mix'
              ? '混合最容易出问题：中英两套数据里同名的 clip 会被静默吞掉，准备完必须对一遍四个清单的数量。'
              : undefined
          }
          noteTone="warn"
        />
        <Row
          stacked
          label="实验"
          control={
            <KV
              items={[
                ['实验名', experiment],
                ['数据', '412 条 · 1.9 h'],
                ['已核对', 'name2text = semantic = wav32k = cleaned ✓'],
                ['底模', 's2G488k.pth + s1bert']
              ]}
            />
          }
        />
        <Row
          label="webui"
          note="要听效果、要看频谱就去那个界面；面板不重复做试听台。"
          control={<Toggle on={webui} onChange={setWebui} label={webui ? '已开 :9874' : '未开'} />}
          last
        />
      </Card>

      <Card>
        <SectionTitle note="一次训练约 40–90 分钟（RTX 4060，15 epoch）。">运行</SectionTitle>
        <Row
          label="训练记录"
          control={
            running ? (
              <Btn small onClick={() => setRunning(false)}>
                停止
              </Btn>
            ) : (
              <Btn primary onClick={() => setRunning(true)}>
                开始训练
              </Btn>
            )
          }
          note={
            running
              ? '正在跑第 6 / 15 个 epoch；日志尾部会实时写进下面这张表。'
              : '上一次成功产出的是 sovits-zh-e15，可回滚。'
          }
        />
        <Row
          stacked
          last
          label="历史"
          control={
            <Table
              head={['实验', '数据', 'epoch', '结局']}
              rows={[
                [
                  experiment,
                  '412 条',
                  '6 / 15',
                  running ? <Pill tone="warn">训练中</Pill> : <Pill>未开始</Pill>
                ],
                ['zh-e15', '388 条', '15', <Pill tone="ok">成功</Pill>],
                ['en-e15', '240 条', '15', <Pill tone="ok">成功</Pill>]
              ]}
            />
          }
        />
      </Card>

      <Card>
        <SectionTitle note="注册 = 把权重目录登记成一个可选音色，注册完「听话」页的音色列表里就多一项。">
          产物
        </SectionTitle>
        <Row
          label="注册为音色包"
          note="同名会覆盖。同一个说话人重训之前，先把上一代权重改名（例如 -old），否则回滚就没得选了。"
          control={
            <Btn
              small
              onClick={() =>
                setRegistered((prev) => (prev.includes(experiment) ? prev : [...prev, experiment]))
              }
            >
              注册 {experiment}
            </Btn>
          }
        />
        <Row
          label="注册的实验"
          note={registered.length === 0 ? '还没有注册任何音色包。' : undefined}
          control={
            <span style={{ fontSize: FS.small, color: C.dim }}>{registered.join(' · ')}</span>
          }
        />
        <Row
          stacked
          label="训练产物位置"
          control={
            <KV
              items={[
                ['权重', 'data/gpt-sovits/weights/<speaker>/'],
                ['日志', 'logs/<experiment>/train.log'],
                ['上一代', '<name>-old<dataset>-e15.ckpt']
              ]}
            />
          }
          last
        />
      </Card>

      <Banner tone="warn" title="准备完一定数一遍清单">
        扫过一遍目录就算完事，最容易出现「中英混装丢了一半」却照样能开训 ——
        训练不会报错，声音会突然变调。
      </Banner>
      <div style={{ fontSize: FS.small, color: C.dim, fontFamily: MONO }}>
        这一页没有 settings 键：训练版本与实验都从产物目录读出来。
      </div>
      <div style={{ height: 4 }} />
      <span style={{ fontFamily: MONO, fontSize: FS.mini, color: C.dim }}>
        同名的上一代权重先改名，回滚才有得选。
      </span>
    </div>
  )
}
