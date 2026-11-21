/**
 * 这台机器的接线：七段，一段一条腿。
 *
 * 最后一段不是接线，是「这些线都还好吗」—— 所以它列的是体检行，不是设备选择。
 * 每段只显示当前生效的那个值，其余全在「更多」里逐条列；一项都没少，只是不吵。
 */
import * as React from 'react'

import { Banner, Btn, Card, Pill, SectionTitle } from '../kit'
import { C, FS, MONO } from '../tokens'

type Seg = {
  no: string
  name: string
  value: string
  more: number
  ok: boolean
  note?: string
  action?: string
}

export function WirePage(): React.ReactElement {
  const [cableOk, setCableOk] = React.useState(false)
  const [open, setOpen] = React.useState('')

  const segs: Seg[] = [
    { no: '01', name: '听谁说', value: '麦克风阵列（Realtek）', more: 3, ok: true },
    { no: '02', name: '认成什么字', value: 'Qwen3-ASR 0.6B · 799 MB', more: 7, ok: true },
    { no: '03', name: '翻成哪国话', value: 'DeepSeek', more: 8, ok: true },
    {
      no: '04',
      name: '谁来说（声出）',
      value: 'Edge · Jenny',
      more: 8,
      ok: cableOk,
      note: cableOk
        ? 'CABLE Input 已经在输出设备清单里；游戏里把语音输入设成 CABLE Output 就能听见你。'
        : '驱动已装，但输出设备清单里还没出现 CABLE Input（VB-Audio Virtual Cable）：点重新检测；还是没有就重启一次电脑',
      action: cableOk ? undefined : '重新检测'
    },
    { no: '05', name: '念给谁听（朗读）', value: '本地离线嗓 · 中文', more: 13, ok: true },
    { no: '06', name: '浮层与送键', value: '未锁定 · 420×132', more: 7, ok: true },
    { no: '07', name: '这台机器', value: '6/6 行有数据 · Steam 库：自动', more: 6, ok: true }
  ]

  return (
    <div>
      <Card>
        <SectionTitle note="七段，一段一条腿；最后一段不是接线，是「这些线都还好吗」。每段只留当前生效的那个值，其余全在「更多」里逐条列 —— 一项都没少，只是不吵。">
          这台机器的接线
        </SectionTitle>
        {segs.map((s, i) => {
          const expanded = open === s.no
          return (
            <div
              key={s.no}
              style={{ borderTop: i === 0 ? 'none' : `1px solid ${C.line}`, padding: '9px 0' }}
            >
              <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 8 }}>
                <span style={{ fontFamily: MONO, fontSize: FS.mini, color: C.dim, width: 18 }}>
                  {s.no}
                </span>
                <Pill tone={s.ok ? 'ok' : 'warn'}>{s.ok ? '就绪' : '缺一步'}</Pill>
                <span style={{ fontSize: FS.body, color: C.text }}>{s.name}</span>
                <span style={{ flex: '1 1 8rem' }} />
                <span style={{ fontSize: FS.small, color: s.ok ? C.text : C.warn }}>{s.value}</span>
              </div>
              {s.note ? (
                <div
                  style={{
                    display: 'flex',
                    flexWrap: 'wrap',
                    alignItems: 'baseline',
                    gap: 8,
                    marginTop: 6,
                    fontSize: FS.small,
                    lineHeight: 1.6,
                    color: s.ok ? C.dim : C.warn
                  }}
                >
                  <span style={{ flex: '1 1 260px', minWidth: 0, wordBreak: 'break-word' }}>
                    {s.note}
                  </span>
                  {s.action ? (
                    <span style={{ flex: '0 0 auto' }}>
                      <Btn small onClick={() => setCableOk(true)}>
                        {s.action}
                      </Btn>
                    </span>
                  ) : null}
                </div>
              ) : null}
              <div style={{ marginTop: 4 }}>
                <button
                  type="button"
                  onClick={() => setOpen(expanded ? '' : s.no)}
                  style={{
                    background: 'transparent',
                    border: 'none',
                    color: C.dim,
                    fontSize: FS.small,
                    padding: 0,
                    cursor: 'pointer'
                  }}
                >
                  更多 · 这一段的 {s.more} 项 {expanded ? '▴' : '▾'}
                </button>
                {expanded ? (
                  <div
                    style={{
                      marginTop: 6,
                      paddingLeft: 26,
                      fontSize: FS.small,
                      color: C.dim,
                      lineHeight: 1.8
                    }}
                  >
                    {s.no === '04' ? (
                      <>
                        声出引擎 Edge 免费 · 音色 Jenny（女 · 英语） · 输出 CABLE Input · 本机也播放
                        关 · 同声翻译 开 …
                      </>
                    ) : s.no === '07' ? (
                      <>
                        麦克风 3 个输入 · 扬声器 4 个输出 · 虚拟声卡 {cableOk ? '已就绪' : '缺端点'}{' '}
                        · Python 3.11 · 显存 12 GB · GSI 端口 32120 占着
                      </>
                    ) : (
                      <>这一段的其余 {s.more - 1} 项在它自己的页上调（点左边导航去改）。</>
                    )}
                  </div>
                ) : null}
              </div>
            </div>
          )
        })}
        <div style={{ display: 'flex', gap: 6, marginTop: 12 }}>
          <Btn primary>试一句</Btn>
          <Btn>测试出声</Btn>
        </div>
      </Card>

      <Banner tone="info" title="这一段为什么单独一页">
        面板里七段各自有主页，但开局前要的是一眼看全：哪一段缺一步。所以这里只有「一条腿一行」，改值仍回各自的页。
      </Banner>
      <div style={{ fontSize: FS.small, color: C.dim, fontFamily: MONO }}>
        这一段是只读汇总，没有任何设置项。
      </div>
    </div>
  )
}
