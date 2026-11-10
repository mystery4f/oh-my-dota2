import type React from 'react'
import type { OverlayStatus } from '@shared/ipc'
import type { SpokenStatus } from '@shared/voice-out'
import { formatStageTrace } from '@shared/voice-stage'
import { heroHue } from '@shared/overlay-ledger'
import { heroUrl } from './hero'
import type { LedgerRow } from '@shared/overlay-ledger'

/**
 * 一行消息怎么显示：
 * 译文模式隐藏「已有译文的聊天行」的原文（voice 行不藏——那是用户自己的话）；
 * 原文模式隐藏译文；其余全显。逐行判，不再依赖全局 CSS 数据属性。
 */
function showOriginal(row: LedgerRow, textMode: OverlayStatus['textMode']): boolean {
  if (textMode === 'original') return true
  if (row.own) return true
  return !(row.translated !== null && row.translated !== undefined && !row.pending)
}

function showTranslation(row: LedgerRow, textMode: OverlayStatus['textMode']): boolean {
  return textMode !== 'original' && (row.translated !== null || row.error !== undefined)
}

function ChatRow(props: {
  row: LedgerRow
  textMode: OverlayStatus['textMode']
  spoken?: SpokenStatus
  /** 阶段留痕（voice-stage）：主进程发什么就画什么，缺省时退回「翻译中…」。 */
  trace?: string
}): JSX.Element {
  const { row, textMode, spoken, trace } = props
  // 没有快照但还在等译文（OCR/GSI 的普通行也走这条）：退回原来的「翻译中…」，不新造第三个词。
  const stageText = trace ?? (row.pending ? formatStageTrace({ marks: [], current: 'translate' }) : undefined)
  const url = heroUrl(row.hero)
  const classes = ['row']
  if (row.pending) classes.push('pending')
  if (row.dim) classes.push('dim')
  // 英雄色条：行左缘一条 3px 的英雄主题色，没有英雄的行不画（浮层唯一的装饰色）。
  const hue = row.hero === undefined ? null : heroHue(row.hero)
  return (
    <div className={classes.join(' ')} style={hue === null ? undefined : ({ '--hue': hue } as React.CSSProperties)}>
      {url !== undefined && <img className="hero-img" src={url} alt="" draggable={false} />}
      {showOriginal(row, textMode) && (
        <div className="orig">
          {row.original}
          {stageText !== undefined && <span className="trace"> · {stageText}</span>}
        </div>
      )}
      {showTranslation(row, textMode) &&
        (row.error !== undefined ? (
          <div className="trans err">✕ {row.error}</div>
        ) : (
          <div className={row.cached ? 'trans cached' : 'trans'}>{row.translated}</div>
        ))}
      {spoken && <div className={spoken.ok ? 'spoken ok' : 'spoken err'}>{spoken.text}</div>}
    </div>
  )
}

/** 消息行列表：账本即真相，渐隐（dim）由 fadeRows 算好放进行里。 */
export function ChatRows(props: {
  rows: LedgerRow[]
  spokenById: Record<string, SpokenStatus>
  /** 对讲行的阶段留痕：rowId → 一行字（主进程快照渲染出来的）。 */
  traceById: Record<string, string>
  status: OverlayStatus
}): JSX.Element {
  const { rows, spokenById, traceById, status } = props
  return (
    <div id="list">
      {rows.length === 0 && <div className="row hint">等待聊天捕获 · 开始捕获后，双语消息会浮在这里</div>}
      {rows.map((row) => (
        <ChatRow
          key={row.id}
          row={row}
          textMode={status.textMode}
          spoken={spokenById[row.id]}
          trace={traceById[row.id]}
        />
      ))}
    </div>
  )
}
