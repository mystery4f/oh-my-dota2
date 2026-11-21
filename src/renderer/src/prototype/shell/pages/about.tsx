/**
 * 关于：版本、诊断、文档。这一页是「出了问题该把这台机器的什么交出去」的唯一入口。
 *
 * 诊断三件事都只读：最近的错误、译文抽检、导出。没有任何一键「修复」按钮。
 */
import * as React from 'react'

import { Btn, Card, KV, Pill, Row, SectionTitle, Table } from '../kit'
import { C, FS, MONO } from '../tokens'

const ERRORS = [
  ['12:00:04', 'main', 'TLS 连接超时（api.deepseek.com）', '2'],
  ['11:41:52', 'main', 'node:sqlite 警告：database is locked', '1'],
  ['11:20:11', 'renderer', 'Unhandled rejection: AbortError', '1']
]

export function AboutPage(): React.ReactElement {
  const [exported, setExported] = React.useState('')

  return (
    <div>
      <Card>
        <SectionTitle>版本</SectionTitle>
        <Row
          label="当前版本"
          control={<span style={{ fontFamily: MONO, fontSize: FS.small }}>v1.2.0</span>}
        />
        <Row
          label="更新"
          note="稳定通道，只在你有空的时候提示；不会自己重启。"
          control={
            <>
              <Pill tone="ok">已是最新</Pill>
              <Btn small>检查更新</Btn>
            </>
          }
        />
        <Row
          label="构建时间"
          control={
            <span style={{ fontFamily: MONO, fontSize: FS.small, color: C.dim }}>
              2026-11-21 03:41 · d341ebb
            </span>
          }
          last
        />
      </Card>

      <Card>
        <SectionTitle note="最近的错误是主进程自己记下来的（logs/errors.jsonl），不转发渲染层的报错。">
          诊断
        </SectionTitle>
        <Row
          label="自己说话时的回声"
          hint="半双工守卫：在本机播报的 1.2 秒里捕获到的音频直接丢弃 · 今天丢了 0 段"
          control={<Pill tone="ok">守卫在</Pill>}
        />
        <Row
          label="模型调用"
          hint="今天 42 次 · 失败 1 · P50 1.4 秒 · 最近一次 12:00:04（api.deepseek.com TLS 超时）"
          control={<Btn small>看明细</Btn>}
        />
        <Row
          label="探针清单"
          hint="只列出，不在这里跑：跑探针要独占应用（GSI 端口 32123），会把你正在看的那局挤掉"
          control={<Btn small>看清单</Btn>}
        />
        <Row
          stacked
          label="最近的错误"
          hint="3 条"
          control={
            <Table
              head={['时间', '来源', '一句话', '次数']}
              rows={ERRORS.map(([t, who, msg, n]) => [
                <span style={{ fontFamily: MONO, color: C.dim }}>{t}</span>,
                <span style={{ color: C.dim }}>{who}</span>,
                msg,
                <span style={{ fontFamily: MONO }}>{n}</span>
              ])}
            />
          }
        />
        <Row
          label="译文抽检"
          note="随机取 20 条最近的翻译，把原文与译文并排；看完没有「翻反了」这类硬伤就行。"
          control={<Btn small>抽 20 条看看</Btn>}
        />
        <Row
          label="导出诊断包"
          note="日志 + 设置（密钥打码）+ 环境快照，一个 zip；不会带上你的录音。"
          control={
            <Btn small onClick={() => setExported('Diagnostics-20261121-1207.zip')}>
              {exported ? '已导出' : '导出'}
            </Btn>
          }
        />
        <Row label="导出设置包" note="只含设置，换机器时用。" control={<Btn small>导出</Btn>} />
        <Row
          label="导入设置包"
          note="导入后立即生效并重新注册热键。"
          control={<Btn small>导入</Btn>}
          last
        />
        {exported ? (
          <div style={{ marginTop: 6, fontSize: FS.small, color: C.accent }}>
            ✓ 已写到 {exported}
          </div>
        ) : null}
      </Card>

      <Card>
        <SectionTitle>文档</SectionTitle>
        <Row
          label="设计文档"
          hint="为什么这么设计"
          note="docs/DESIGN-panel-v2.md · docs/ARCH-notes.md"
          control={<Btn small>打开</Btn>}
        />
        <Row
          label="排障手册"
          hint="症状 → 原因 → 修法"
          note="docs/ACCEPTANCE.md 的排障表 · docs/NOTES.md"
          control={<Btn small>打开</Btn>}
        />
        <Row
          label="术语表"
          hint="这些词在这套代码里是什么意思"
          note="GLOSSARY.md"
          control={<Btn small>打开</Btn>}
          last
        />
      </Card>

      <Card>
        <KV
          items={[
            ['数据目录', '与安装目录同级：<安装目录>-data'],
            ['日志', 'logs/errors.jsonl · logs/gsi-chat.jsonl · logs/voice-chain.jsonl'],
            ['这台机器', 'Windows 11 · Electron 37 · Node 22.21']
          ]}
        />
      </Card>
      <div style={{ fontSize: FS.small, color: C.dim, fontFamily: MONO }}>
        这一页只读：没有任何一条设置在这里改。
      </div>
    </div>
  )
}
