import { useCallback, useEffect, useRef, useState } from 'react'
import type { CaptureEntry, OverlayStatus, PanelSuggestionsResult } from '@shared/ipc'
import { pickPhrase } from '@shared/overlay-ledger'

type Tab = 'history' | 'phrases' | 'suggest'

const TABS: { id: Tab; label: string }[] = [
  { id: 'history', label: '历史' },
  { id: 'phrases', label: '快捷短语' },
  { id: 'suggest', label: 'AI 建议' }
]

/**
 * 呼出面板：浮层临时变成可交互面板（热键 Alt+Shift+H）。
 * 三个标签页都只「复制」，不发送——复制比自动发送安全，也绕开对局里的焦点争夺。
 * 关闭交还穿透：Esc 或再按一次热键（主进程 togglePanel 管状态）。
 */
export function SummonPanel(props: { status: OverlayStatus; onStatus: (s: OverlayStatus) => void }): JSX.Element {
  const { status } = props
  const [tab, setTab] = useState<Tab>('history')
  // 按钮上写着「关闭（Esc）」，这里就得真的能关。主进程 togglePanel 管状态与穿透恢复。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Escape') return
      event.preventDefault()
      void window.api.overlayPanelToggle().then(props.onStatus)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onStatus])
  return (
    <div id="panel">
      <div id="panel-head">
        <div className="tabs">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              className={tab === item.id ? 'tab on' : 'tab'}
              onClick={() => setTab(item.id)}
            >
              {item.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          className="panel-close"
          onClick={() => void window.api.overlayPanelToggle().then(props.onStatus)}
        >
          关闭（Esc）
        </button>
      </div>
      <div id="panel-body">
        {tab === 'history' && <HistoryTab />}
        {tab === 'phrases' && <PhrasesTab phrases={status.quickPhrases} />}
        {tab === 'suggest' && <SuggestTab />}
      </div>
    </div>
  )
}

/** 点一下复制 + 600ms「已复制」反馈：这一块是三个标签页共用的行为。 */
function useCopy(): { copiedId: string | null; copy(id: string, text: string): void } {
  const [copiedId, setCopiedId] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current)
    },
    []
  )
  const copy = useCallback((id: string, text: string): void => {
    void window.api.copyText(text)
    setCopiedId(id)
    if (timer.current) clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopiedId(null), 600)
  }, [])
  return { copiedId, copy }
}

function CopyRow(props: {
  id: string
  primary: string
  secondary?: string
  copied: boolean
  selected?: boolean
  onCopy: () => void
}): JSX.Element {
  return (
    <div className={props.selected ? 'copy-row selected' : 'copy-row'} onClick={props.onCopy}>
      <span className="copy-primary">{props.primary}</span>
      {props.secondary && <span className="copy-secondary">{props.secondary}</span>}
      <span className={props.copied ? 'copied ok' : 'copied'}>{props.copied ? '已复制' : ''}</span>
    </div>
  )
}

function HistoryTab(): JSX.Element {
  const [rows, setRows] = useState<CaptureEntry[] | null>(null)
  const { copiedId, copy } = useCopy()
  useEffect(() => {
    let alive = true
    void window.api.chatHistory().then((entries) => {
      if (alive) setRows(entries)
    })
    return () => {
      alive = false
    }
  }, [])
  if (rows === null) return <div className="panel-note">读取中…</div>
  if (rows.length === 0) return <div className="panel-note">还没有聊天记录 · 开始捕获后这里会有最近 200 条</div>
  // 新的在上：翻历史找「刚才那句话」不用滚到底。
  const newest = [...rows].reverse()
  return (
    <div className="scroll">
      {newest.map((entry) => (
        <CopyRow
          key={entry.id}
          id={entry.id}
          primary={entry.translated ?? entry.original}
          secondary={entry.translated !== null ? entry.original : undefined}
          copied={copiedId === entry.id}
          onCopy={() => copy(entry.id, entry.translated ?? entry.original)}
        />
      ))}
    </div>
  )
}

function PhrasesTab(props: { phrases: string[] }): JSX.Element {
  const { phrases } = props
  const [index, setIndex] = useState(-1)
  const { copiedId, copy } = useCopy()
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (phrases.length === 0) return
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setIndex((current) => pickPhrase(phrases.length, current + 1))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setIndex((current) => pickPhrase(phrases.length, current - 1))
      } else if (event.key === 'Enter' && index >= 0) {
        event.preventDefault()
        copy(`phrase-${index}`, phrases[index])
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [phrases, index, copy])
  if (phrases.length === 0) return <div className="panel-note">短语表是空的 · 在面板「对局」页里添加</div>
  return (
    <div className="scroll">
      {phrases.map((phrase, i) => (
        <CopyRow
          key={phrase + i}
          id={`phrase-${i}`}
          primary={phrase}
          copied={copiedId === `phrase-${i}`}
          selected={i === index}
          onCopy={() => copy(`phrase-${i}`, phrase)}
        />
      ))}
      <div className="panel-note kbd-note">方向键选 · Enter 复制</div>
    </div>
  )
}

function SuggestTab(): JSX.Element {
  const [result, setResult] = useState<PanelSuggestionsResult | null>(null)
  const [loading, setLoading] = useState(false)
  const { copiedId, copy } = useCopy()
  const load = useCallback((): void => {
    setLoading(true)
    void window.api
      .panelSuggestions()
      .then(setResult)
      .finally(() => setLoading(false))
  }, [])
  useEffect(() => {
    load()
  }, [load])
  if (loading && result === null) return <div className="panel-note">根据最近的聊天想几条回复…</div>
  if (result !== null && !result.ok) {
    return (
      <div className="panel-note">
        {result.error ?? '生成失败'}
        <button type="button" className="retry" onClick={load}>
          重试
        </button>
      </div>
    )
  }
  if (result === null || result.items.length === 0) return <div className="panel-note">没有可用的建议 · 生成几条聊天后重试</div>
  return (
    <div className="scroll">
      {result.items.map((item, i) => (
        <CopyRow
          key={item + i}
          id={`sug-${i}`}
          primary={item}
          copied={copiedId === `sug-${i}`}
          onCopy={() => copy(`sug-${i}`, item)}
        />
      ))}
      <div className="panel-note kbd-note">点一条复制 · 再按热键或 Esc 回到游戏</div>
    </div>
  )
}
