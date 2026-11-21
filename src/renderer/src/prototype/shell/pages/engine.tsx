/**
 * 翻译引擎：谁在翻、翻成什么样、翻错了能查到哪一条。
 *
 * 这页最容易被塞成「一屏设置」，所以顺序按「先连通，再调输出，最后才是质量与词表」排。
 */
import * as React from 'react'

import {
  Banner,
  Btn,
  Card,
  Chips,
  KV,
  Pill,
  Row,
  SectionTitle,
  SelectBox,
  Slider,
  Table,
  Toggle
} from '../kit'
import { C, FS, MONO } from '../tokens'

const PRESETS = [
  { id: 'deepseek', label: 'DeepSeek' },
  { id: 'xiaomi', label: '小米 MiMo' },
  { id: 'custom', label: '自定义（OpenAI 兼容）' }
]

const MODELS: Record<string, { id: string; label: string }[]> = {
  deepseek: [
    { id: 'chat', label: 'deepseek-chat' },
    { id: 'reasoner', label: 'deepseek-reasoner' }
  ],
  xiaomi: [{ id: 'mimo', label: 'mimo-7b-rl' }],
  custom: [{ id: 'custom', label: '按接口地址自己填' }]
}

const LANGS = [
  { id: 'en', label: '英语' },
  { id: 'ja', label: '日语' },
  { id: 'ru', label: '俄语' }
]

const LEDGER = [
  ['12:07:41', 'gank 中路，等我', 'Gank mid, wait for me', '1.8 s'],
  ['12:07:02', '他们开雾了', 'They smoked', '1.1 s'],
  ['12:06:33', '买活', 'Buyback', '0.9 s'],
  ['12:05:58', '这波别追', "Don't chase this one", '2.4 s']
]

export function EnginePage(): React.ReactElement {
  const [preset, setPreset] = React.useState('deepseek')
  const [model, setModel] = React.useState('chat')
  const [reasoning, setReasoning] = React.useState(false)
  const [conn, setConn] = React.useState<'idle' | 'testing' | 'ok' | 'bad'>('ok')
  const [lang, setLang] = React.useState('en')
  const [maxWords, setMaxWords] = React.useState(24)
  const [cache, setCache] = React.useState(true)
  const [pack, setPack] = React.useState('builtin')
  const [probe, setProbe] = React.useState('')
  const [probeOut, setProbeOut] = React.useState('')

  const test = (): void => {
    setConn('testing')
    window.setTimeout(() => setConn(Math.random() > 0.25 ? 'ok' : 'bad'), 900)
  }

  return (
    <div>
      <Card>
        <SectionTitle note="一个预设就是一套「接口地址 + 模型 + 默认参数」，换供应商只改这一处。">
          服务
        </SectionTitle>
        <Row
          label="预设"
          control={
            <Chips
              value={preset}
              onChange={(id) => {
                setPreset(id)
                setModel(MODELS[id][0].id)
              }}
              options={PRESETS.map((p) => ({ ...p }))}
            />
          }
        />
        <Row
          label="接口地址"
          note={
            preset === 'deepseek'
              ? '国内直连，不需要代理。'
              : preset === 'xiaomi'
                ? '国内直连。'
                : 'OpenAI 兼容即可，需要自己确认路径以 /chat/completions 结尾。'
          }
          control={
            <span style={{ fontFamily: MONO, fontSize: FS.small, color: C.dim }}>
              {preset === 'deepseek'
                ? 'https://api.deepseek.com/v1'
                : preset === 'xiaomi'
                  ? 'https://api.xiaomimimo.com/v1'
                  : 'https://your-host/v1'}
            </span>
          }
        />
        <Row
          label="密钥"
          note="存在 settings.json 里，按 provider 分开保存；导出的设置包里会打码。"
          control={<Pill tone="ok">已配置 · sk-…9f2c</Pill>}
        />
        <Row
          label="模型"
          control={
            <SelectBox value={model} onChange={setModel} width={210} options={MODELS[preset]} />
          }
        />
        <Row
          label="推理（先思考再翻）"
          note="开着一句话要多等 1–3 秒，换来的是长句更准。对局里的短句不值得开。"
          control={
            <Toggle on={reasoning} onChange={setReasoning} label={reasoning ? '开' : '关'} />
          }
        />
        <Row
          label="连通性"
          note={
            conn === 'bad'
              ? '连不上：检查密钥、接口地址，或这台机器是不是要走代理。'
              : conn === 'testing'
                ? '正在发一条最短的请求…'
                : '刚才测过一次，返回了 412 ms。'
          }
          noteTone={conn === 'bad' ? 'bad' : 'dim'}
          control={
            <>
              <Btn small onClick={test} disabled={conn === 'testing'}>
                {conn === 'testing' ? '测试中…' : '测试'}
              </Btn>
              <Pill tone={conn === 'ok' ? 'ok' : conn === 'bad' ? 'bad' : 'idle'}>
                {conn === 'ok' ? '通' : conn === 'bad' ? '不通' : '未测'}
              </Pill>
            </>
          }
          last
        />
      </Card>

      <Card>
        <SectionTitle>输出</SectionTitle>
        <Row
          label="浮层译文语言"
          note="队友打字是英文时，翻成什么显示在原文下面。"
          control={<Chips value={lang} onChange={setLang} options={LANGS.map((l) => ({ ...l }))} />}
        />
        <Row
          stacked
          label="译文词数上限"
          hint="超了会截断成短句"
          control={
            <Slider
              value={maxWords}
              min={8}
              max={60}
              step={2}
              onChange={setMaxWords}
              suffix=" 词"
            />
          }
        />
      </Card>

      <Card>
        <SectionTitle note="按「方向 + 语气 + 场景」分文件，试翻的记录永远不会污染正式对局的历史。">
          缓存
        </SectionTitle>
        <Row
          label="翻译缓存"
          hint="命中率 63%"
          note="同一句重复出现就直接用上次的译文，省一次调用。清空后第一句会慢一点点。"
          control={
            <>
              <Toggle on={cache} onChange={setCache} label={cache ? '开' : '关'} />
              <Btn small>清空</Btn>
            </>
          }
          last
        />
      </Card>

      <Card>
        <SectionTitle>质量</SectionTitle>
        <Row
          stacked
          label="翻译记账本"
          hint="最近 200 条"
          control={
            <Table
              head={['时间', '原文', '译文', '耗时']}
              rows={LEDGER.map(([t, a, b, ms]) => [
                <span style={{ fontFamily: MONO, color: C.dim }}>{t}</span>,
                a,
                <span style={{ color: C.dim }}>{b}</span>,
                <span style={{ fontFamily: MONO }}>{ms}</span>
              ])}
            />
          }
          last
        />
      </Card>

      <Card>
        <SectionTitle note="词表只影响专用名词：英雄名、装备名、队内黑话。">词表</SectionTitle>
        <Row
          label="现役词表"
          note="坏文件会回落到内置词表并在总览报警，不会让翻译直接失败。"
          control={
            <SelectBox
              value={pack}
              onChange={setPack}
              width={210}
              options={[
                { id: 'builtin', label: '内置（英雄 + 装备）' },
                { id: 'team', label: '队内黑话 v3' },
                { id: 'none', label: '不使用词表' }
              ]}
            />
          }
          last
        />
      </Card>

      <Card>
        <SectionTitle note="用真的模型翻一次，看它是不是你要的效果；这里不写任何缓存。">
          试验台
        </SectionTitle>
        <Row
          stacked
          label="队友发言 → 中文"
          control={
            <div style={{ display: 'grid', gap: 6 }}>
              <input
                value={probe}
                onChange={(e) => setProbe(e.target.value)}
                placeholder="mid no vision, care"
                style={{
                  background: C.card2,
                  border: `1px solid ${C.line2}`,
                  borderRadius: 7,
                  color: C.text,
                  fontSize: FS.small,
                  padding: '6px 9px',
                  fontFamily: MONO
                }}
              />
              <div style={{ display: 'flex', gap: 6 }}>
                <Btn small onClick={() => setProbeOut(probe ? '中路没眼，小心' : '（先输入一句）')}>
                  翻一次
                </Btn>
                <span style={{ fontSize: FS.small, color: C.dim }}>
                  {probeOut || '结果会出现在这里'}
                </span>
              </div>
            </div>
          }
        />
        <Row
          stacked
          label="我的回复 → 英文"
          control={
            <div style={{ display: 'flex', gap: 6 }}>
              <input
                placeholder="等我一下"
                style={{
                  background: C.card2,
                  border: `1px solid ${C.line2}`,
                  borderRadius: 7,
                  color: C.text,
                  fontSize: FS.small,
                  padding: '6px 9px',
                  fontFamily: MONO
                }}
              />
              <Btn small>翻一次</Btn>
            </div>
          }
          last
        />
      </Card>

      {conn === 'bad' ? (
        <Banner tone="bad" title="模型服务不通">
          每一句都会走不到翻译那一步；先把上面的连通性测通，再开语音对讲。
        </Banner>
      ) : null}
      <Card>
        <KV
          columns={2}
          items={[
            ['会话文件', 'data/sessions/translator-<hash>.sqlite'],
            ['历史侧车', 'conversations-<hash>.json'],
            ['按什么分', '方向 · 语气 · 场景（prod / try / warm）'],
            ['试翻隔离', 'try 槽，不进 prod']
          ]}
        />
      </Card>
      <div style={{ fontSize: FS.small, color: C.dim, lineHeight: 1.7 }}>
        收起来的三项没有消失：代理地址仍是 settings.proxyUrl（走代理才填），子句流水仍是
        settings.clauseStreamVoice，保真守卫随「翻译记账本」一起生效 —— 它们都是装机时定一次、
        整局不碰的东西，所以不再各占一行。
      </div>
      <div style={{ fontSize: FS.small, color: C.dim, fontFamily: MONO }}>
        settings: provider · providerKeys · providerReasoning · proxyUrl · targetLang ·
        translationMaxWords · clauseStreamVoice · glossaryPackName
      </div>
    </div>
  )
}
