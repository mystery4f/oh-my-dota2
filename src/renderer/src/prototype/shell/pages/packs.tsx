/**
 * 音色包：一个包 = 参考音频 + 它自己的微调权重；选了哪个，朗读和声出都用它。
 *
 * 这一页替掉真面板那个 367 行弹窗（三 tab：清单 / 参考音频 / GV 服务），理由是弹窗在 780 px
 * 里三 tab 太挤，而「我训的那个包怎么变成现役」需要和音色训练的产物排在一起看。
 */
import * as React from 'react'

import { Banner, Bar, Btn, Card, Pill, Row, SectionTitle, SelectBox } from '../kit'
import { C, FS, MONO } from '../tokens'

type Pack = {
  id: string
  name: string
  note: string
  version: string
  size: string
  installed: boolean
  active: boolean
  progress: number
  /** 装失败时的一句话原因：源站/尺寸/校验哪一类，说清下次还能不能重试 */
  fail?: string
}

const INITIAL_PACKS: Pack[] = [
  {
    id: 'jenny',
    name: 'jenny-en-v2',
    note: '英式女声 · 参考音频来自公开语料',
    version: 'v2',
    size: '92 MB',
    installed: true,
    active: true,
    progress: 0
  },
  {
    id: 'xie',
    name: '老谢-中文-1218',
    note: '自己训的：48 条录音 · 12 epoch',
    version: 'v1 → v2',
    size: '92 MB',
    installed: true,
    active: false,
    progress: 0
  },
  {
    id: 'seed',
    name: '晓晓保底',
    note: '用免费的 Edge 嗓子现合成一条参考，不下载模型',
    version: 'v1',
    size: '3 MB',
    installed: true,
    active: false,
    progress: 0
  },
  {
    id: 'ping',
    name: '中文女声-小苹',
    note: '没装过；列表里只显示还需多少',
    version: 'v1',
    size: '还需 78 MB',
    installed: false,
    active: false,
    progress: 0
  },
  {
    id: 'aji',
    name: '中文男声-阿吉',
    note: '上一个版本装到一半断了',
    version: 'v1',
    size: '还需 92 MB',
    installed: false,
    active: false,
    progress: 0,
    fail: '源站 404 · 换镜像也不行，等清单更新'
  }
]

const REFS = [
  { id: 'xie', text: '老谢-中文-1218 · 微调' },
  { id: 'seed', text: '晓晓保底' },
  { id: 'jenny', text: 'jenny-en-v2 · 微调' }
]

export function PacksPage({ go }: { go: (s: 'voice') => void }): React.ReactElement {
  const [packs, setPacks] = React.useState<Pack[]>(INITIAL_PACKS)
  const [ref, setRef] = React.useState('xie')
  const [seedDone, setSeedDone] = React.useState(false)
  const [prompt, setPrompt] = React.useState('买活好了，别急着上高')
  const [lang, setLang] = React.useState('zh')
  const [wild, setWild] = React.useState('')
  const [phase, setPhase] = React.useState<'off' | 'install' | 'starting' | 'ready'>('off')
  const [dl, setDl] = React.useState(0)
  const [logs, setLogs] = React.useState<string[]>([
    'api_v2 · 未启动（引擎包没装）',
    '上一次：端口 9880 未被占用'
  ])

  const tick = (id: string): void => {
    setPacks((prev) => prev.map((p) => (p.id === id ? { ...p, progress: 0.02 } : p)))
  }

  React.useEffect(() => {
    if (!packs.some((p) => p.progress > 0 && p.progress < 1)) return
    const timer = window.setInterval(() => {
      setPacks((prev) =>
        prev.map((p) => {
          if (p.progress <= 0 || p.progress >= 1) return p
          const next = Math.min(1, p.progress + 0.12)
          return next >= 1
            ? { ...p, progress: 0, installed: true, size: '92 MB', version: 'v1' }
            : { ...p, progress: next }
        })
      )
    }, 220)
    return () => window.clearInterval(timer)
  }, [packs])

  const install = (): void => {
    setPhase('install')
    setDl(0.02)
    setLogs((l) => ['下载引擎包 8.2 GB · 断点续传已开', ...l].slice(0, 6))
  }

  React.useEffect(() => {
    if (phase !== 'install' || dl >= 1) return
    const timer = window.setTimeout(() => setDl((d) => Math.min(1, d + 0.18)), 320)
    return () => window.clearTimeout(timer)
  }, [phase, dl])

  React.useEffect(() => {
    if (phase !== 'install' || dl < 1) return
    setPhase('starting')
    setLogs((l) => ['解压完 · 拉起 api_v2（加载约 40 秒）', ...l].slice(0, 6))
  }, [phase, dl])

  React.useEffect(() => {
    if (phase !== 'starting') return
    const timer = window.setTimeout(() => {
      setPhase('ready')
      setLogs((l) => ['api_v2 ready · http://127.0.0.1:9880 · PID 20184', ...l].slice(0, 6))
    }, 1600)
    return () => window.clearTimeout(timer)
  }, [phase])

  const installed = packs.filter((p) => p.installed)
  const pending = packs.filter((p) => !p.installed)
  const active = packs.find((p) => p.active)
  const downloading = packs.find((p) => p.progress > 0 && p.progress < 1)

  return (
    <>
      <Card>
        <SectionTitle note="未装的单独放一块：还需多少、上次为什么失败、重试在哪，都在这一块里，不混进清单。">
          要下的东西 · {pending.length} 个没装
        </SectionTitle>
        {pending.length === 0 ? (
          <div style={{ fontSize: FS.small, color: C.dim, padding: '6px 0' }}>都装齐了。</div>
        ) : null}
        {pending.map((pack, i) => (
          <Row
            key={pack.id}
            last={i === pending.length - 1}
            stacked
            label={pack.name}
            note={
              pack.fail
                ? `${pack.note}。${pack.fail}`
                : `${pack.note} · ${pack.version} · ${pack.size} · 装完就出现在下面的清单里`
            }
            noteTone={pack.fail ? 'bad' : 'dim'}
            control={
              <>
                {pack.progress > 0 ? (
                  <Pill tone="warn">↓ {Math.round(pack.progress * 100)}%</Pill>
                ) : pack.fail ? (
                  <Pill tone="bad">上次失败</Pill>
                ) : null}
                {pack.progress === 0 ? (
                  <Btn small primary={!pack.fail} onClick={() => tick(pack.id)}>
                    {pack.fail ? '重试' : '下载'}
                  </Btn>
                ) : null}
              </>
            }
          />
        ))}
        {downloading ? (
          <Bar
            value={downloading.progress}
            label={`${downloading.name} 下载中 · 可暂停，关掉应用也不丢`}
          />
        ) : null}
        <Row
          label="清单本身"
          hint="远端拉不到会回落到内置清单，不会给你一张空表"
          last
          control={
            <Btn
              small
              onClick={() => setPacks((prev) => prev.map((p) => ({ ...p, fail: undefined })))}
            >
              拉最新清单
            </Btn>
          }
        />
      </Card>

      <Card>
        <SectionTitle note="选了哪个，朗读和声出都用它 —— 两边共用一个，换了两边一起变。">
          清单 · {installed.length} 个已装
        </SectionTitle>
        {installed.map((pack, i) => (
          <Row
            key={pack.id}
            last={i === installed.length - 1}
            stacked
            label={pack.name}
            note={`${pack.note} · ${pack.version} · ${pack.size}`}
            control={
              <>
                {pack.active ? <Pill tone="ok">使用中</Pill> : null}
                {pack.version.includes('→') ? (
                  <Btn small onClick={() => tick(pack.id)}>
                    升级
                  </Btn>
                ) : null}
                <Btn
                  small
                  primary={!pack.active}
                  disabled={pack.active}
                  onClick={() =>
                    setPacks((prev) => prev.map((p) => ({ ...p, active: p.id === pack.id })))
                  }
                >
                  {pack.active ? '正在用' : '使用'}
                </Btn>
                <Btn
                  small
                  disabled={pack.active}
                  title={pack.active ? '先在别处切到另一个音色再删' : undefined}
                  onClick={() => setPacks((prev) => prev.filter((p) => p.id !== pack.id))}
                >
                  删除
                </Btn>
              </>
            }
          />
        ))}
        <div style={{ marginTop: 10, fontSize: FS.small, color: C.dim }}>
          现在生效：<span style={{ color: C.accent }}>{active?.name ?? '还没选音色包'}</span>
        </div>
      </Card>

      <Card>
        <SectionTitle note="选中即整套换参考（带「微调」的条目会连权重一起切），下一句朗读就生效。">
          参考音频库
        </SectionTitle>
        <Row label="参考音频" hint="库里有 3 条；空库时这一行会写「库是空的」而不是静默留白">
          <SelectBox
            value={ref}
            onChange={setRef}
            options={REFS.map((r) => ({ id: r.id, label: r.text }))}
          />
        </Row>
        {!seedDone ? (
          <Row label="保底参考" hint="用免费的 Edge 嗓子现合成一条晓晓参考写进库里，不下载模型">
            <Btn small onClick={() => setSeedDone(true)}>
              现合成一条
            </Btn>
          </Row>
        ) : (
          <Row label="保底参考" hint="已有晓晓参考，这一行不再出现">
            <Pill tone="ok">已写进库</Pill>
          </Row>
        )}
        <Row label="逐字转写" hint="参考音频说了什么，一字不差；对不上音质会明显劣化">
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            style={{
              width: 320,
              background: C.card2,
              border: `1px solid ${C.line2}`,
              borderRadius: 6,
              color: C.text,
              fontFamily: 'inherit',
              fontSize: FS.body,
              padding: '4px 8px'
            }}
          />
          <SelectBox
            value={lang}
            onChange={setLang}
            options={[
              { id: 'zh', label: '中文' },
              { id: 'en', label: '英文' }
            ]}
          />
        </Row>
        <Row
          label="野路径"
          stacked
          hint="服务端磁盘上的绝对路径；一般从上面库里选，这里留给临时试音"
          last
        >
          <div style={{ width: '100%' }}>
            <input
              value={wild}
              placeholder="D:/data/gpt-sovits/refs/lixiaoyao.wav"
              onChange={(e) => setWild(e.target.value)}
              style={{
                width: '100%',
                background: C.card2,
                border: `1px solid ${C.line2}`,
                borderRadius: 6,
                color: C.text,
                fontFamily: MONO,
                fontSize: FS.small,
                padding: '5px 8px'
              }}
            />
            <div style={{ marginTop: 4, fontSize: FS.mini, color: wild ? C.warn : C.dim }}>
              {wild
                ? '填了野路径就等于绕过库：包里的权重不会跟着切。'
                : '空 = 只用上面库里那一条。'}
            </div>
          </div>
        </Row>
      </Card>

      <Card>
        <SectionTitle note="引擎包 → 服务 → 参考音频，缺哪一环就说哪一环；没有包的时候服务起来也白起。">
          GV 服务
        </SectionTitle>
        <Row label="引擎包目录" hint="填了应用启动时自动拉起 api_v2（加载约 40 秒），退出时收掉">
          <span style={{ fontFamily: MONO, fontSize: FS.small, color: C.dim }}>
            data/gpt-sovits（留空＝这里）
          </span>
        </Row>
        <Row label="服务地址" hint="整合包 runtime 起的本地端口">
          <span style={{ fontFamily: MONO, fontSize: FS.small, color: C.dim }}>
            http://127.0.0.1:9880
          </span>
        </Row>
        <Row
          label="服务"
          note={
            phase === 'ready'
              ? 'api_v2 · PID 20184 · 显存 8.4 GB'
              : phase === 'starting'
                ? '正在拉起：加载模型约 40 秒，别关应用'
                : '引擎包没装：这一步不通，声出选 GV 会直接报「没有音色包」'
          }
          noteTone={phase === 'ready' ? 'ok' : phase === 'off' ? 'dim' : 'warn'}
          control={
            <>
              <Pill tone={phase === 'ready' ? 'ok' : phase === 'starting' ? 'warn' : 'bad'}>
                {phase === 'ready'
                  ? '服务运行中'
                  : phase === 'starting'
                    ? '正在拉起'
                    : '服务未启动'}
              </Pill>
              {phase === 'off' ? (
                <Btn small onClick={install}>
                  下载引擎包（8.2 GB）
                </Btn>
              ) : null}
              {phase === 'install' ? <Pill tone="warn">下载中 {Math.round(dl * 100)}%</Pill> : null}
            </>
          }
        />
        {phase === 'install' ? <Bar value={dl} label="8.2 GB · 断点续传 · 走镜像" /> : null}
        <Row label="日志" stacked hint={`最近 ${logs.length} 行`} last>
          <pre
            style={{
              margin: 0,
              maxHeight: 96,
              overflow: 'auto',
              background: C.card2,
              border: `1px solid ${C.line}`,
              borderRadius: 6,
              padding: '6px 8px',
              fontFamily: MONO,
              fontSize: FS.mini,
              color: C.dim,
              whiteSpace: 'pre-wrap'
            }}
          >
            {logs.join('\n')}
          </pre>
        </Row>
      </Card>

      <Banner
        tone="info"
        title="新包从哪来"
        action={
          <Btn small onClick={() => go('voice')}>
            去音色训练
          </Btn>
        }
      >
        训练产物在 音色训练 → 产物 → 「注册为音色包」；注册完就出现在这一页的清单里，不用重开应用。
      </Banner>
    </>
  )
}
