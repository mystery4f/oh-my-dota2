import { useCallback, useEffect, useRef, useState } from 'react'
import type { CaptureEntry, OverlayStatus, PanelSuggestionsResult } from '@shared/ipc'
import { visionLine, visionShotLine, type VisionAnswer, type VisionReadiness } from '@shared/vision'
import { filterHistory, historyCopyText, pickPhrase } from '@shared/overlay-ledger'
import { directionLabel } from '@shared/translate-direction'

type Tab = 'history' | 'phrases' | 'suggest' | 'look'

const TABS: { id: Tab; label: string }[] = [
  { id: 'history', label: '历史' },
  { id: 'phrases', label: '快捷短语' },
  { id: 'suggest', label: 'AI 建议' },
  // 看一眼（#135）：用户主动按一次才截屏，绝不后台轮询——每一次都是真的模型调用。
  { id: 'look', label: '看一眼' }
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
        {tab === 'look' && <LookTab />}
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
  /** 行尾的小按钮（方向标）：点了不算复制，所以自己拦掉事件冒泡。 */
  badge?: { label: string; title: string; onClick: () => void }
}): JSX.Element {
  return (
    <div className={props.selected ? 'copy-row selected' : 'copy-row'} onClick={props.onCopy}>
      <span className="copy-primary">{props.primary}</span>
      {props.secondary && <span className="copy-secondary">{props.secondary}</span>}
      {props.badge !== undefined && (
        <span
          className="dir-badge"
          title={props.badge.title}
          onClick={(event) => {
            event.stopPropagation()
            props.badge?.onClick()
          }}
        >
          {props.badge.label}
        </span>
      )}
      <span className={props.copied ? 'copied ok' : 'copied'}>{props.copied ? '已复制' : ''}</span>
    </div>
  )
}

/** 手工改过方向的行：这一行显示改判后的方向与重翻出来的译文，只记在这次面板打开期间。 */
type DirectionFix = { direction: 'zh-en' | 'en-zh'; translated: string | null }

function HistoryTab(): JSX.Element {
  const [rows, setRows] = useState<CaptureEntry[] | null>(null)
  const [query, setQuery] = useState('')
  const [fixed, setFixed] = useState<Record<string, DirectionFix>>({})
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
  const hits = filterHistory(newest, query)
  /**
   * 点方向标 = 说「这一句翻错方向了」：先让主进程记住，再拿它重翻出来的译文替换这一行。
   * 重翻要一次模型往返，所以只在人点了之后才发生；失败就把原来的译文留在屏幕上。
   */
  const flipDirection = (entry: CaptureEntry): void => {
    const from = fixed[entry.id]?.direction ?? entry.direction
    if (from === undefined) return
    const direction = from === 'zh-en' ? 'en-zh' : 'zh-en'
    void window.api.translateDirection({ text: entry.body, direction }).then((result) => {
      setFixed((previous) => ({
        ...previous,
        [entry.id]: { direction: result.direction, translated: result.translated }
      }))
    })
  }
  return (
    <>
      <div className="panel-search">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜玩家或关键词 · 空格分词"
          aria-label="搜索聊天记录"
          autoFocus
        />
        {query.trim().length > 0 && (
          <span className="hit">
            {hits.length}/{newest.length}
          </span>
        )}
      </div>
      {hits.length === 0 ? (
        <div className="panel-note">没有命中「{query.trim()}」的记录 · 换个词再试</div>
      ) : (
        <div className="scroll">
          {hits.map((entry) => (
            <CopyRow
              key={entry.id}
              id={entry.id}
              primary={fixed[entry.id]?.translated ?? historyCopyText(entry)}
              secondary={entry.translated !== null ? entry.original : undefined}
              copied={copiedId === entry.id}
              badge={
                entry.direction === undefined
                  ? undefined
                  : {
                      label: directionLabel(fixed[entry.id]?.direction ?? entry.direction),
                      title: '点一下换成另一个方向 · 这一局里记住',
                      onClick: () => flipDirection(entry)
                    }
              }
              onCopy={() => copy(entry.id, fixed[entry.id]?.translated ?? historyCopyText(entry))}
            />
          ))}
        </div>
      )}
    </>
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

/**
 * 看一眼（#135）：按一次才截一帧，问模型，答案只显示在这里。
 * 三种失败要说成三句不同的话——不能看图 / 截不到画面 / 模型没答上来，
 * 混成「失败」的话用户不知道该去改模型、改窗口模式还是重试。
 */
function LookTab(): JSX.Element {
  const { copiedId, copy } = useCopy()
  const [ready, setReady] = useState<VisionReadiness | null>(null)
  const [answer, setAnswer] = useState<VisionAnswer | null>(null)
  const [loading, setLoading] = useState(false)
  useEffect(() => {
    void window.api.visionState().then(setReady)
    // 热键（看一眼）在主进程里就截了帧：结果广播回来，这里只管显示。
    return window.api.onVisionResult(setAnswer)
  }, [])
  const ask = useCallback((): void => {
    setLoading(true)
    void window.api
      .visionAsk()
      .then(setAnswer)
      .finally(() => setLoading(false))
  }, [])
  if (ready === null) return <div className="panel-note">正在看当前模型能不能收图…</div>
  if (!ready.ready) {
    return (
      <div className="panel-note">
        {ready.reason}
        <div className="kbd-note">当前模型：{ready.model || '（没选）'}</div>
      </div>
    )
  }
  return (
    <div className="scroll">
      <div className="panel-note">
        截当前画面问一次模型 · {ready.model}
        <button type="button" className="retry" onClick={ask} disabled={loading}>
          {loading ? '正在看…' : answer === null ? '看一眼' : '再看一次'}
        </button>
      </div>
      {answer === null && !loading && (
        <div className="panel-note kbd-note">点「看一眼」才截屏：不按就不花钱，也不会上传任何画面。</div>
      )}
      {answer !== null && (
        <>
          <div className={answer.ok ? 'panel-note' : 'panel-note err'}>{visionLine(answer)}</div>
          {answer.shot !== null && <div className="panel-note kbd-note">{visionShotLine(answer.shot)}</div>}
          {answer.ok && answer.text.split('\n').map((line, i) => (
            <CopyRow
              key={'look-' + i}
              id={'look-' + i}
              primary={line}
              copied={copiedId === 'look-' + i}
              onCopy={() => copy('look-' + i, line)}
            />
          ))}
        </>
      )}
    </div>
  )
}
