import { useEffect, useState } from 'react'
import type { MatchSnapshot } from '@shared/match-snapshot'
import { boardView } from '@shared/board-view'

/** 一秒一次：看板只显示「现在怎么样」，不需要逐帧。 */
const POLL_MS = 1000

/**
 * 副屏看板（#124a）。只读 `window.api.matchSnapshot()`——那是主进程从 GSI 那一帧里抄出来的
 * 唯一一份快照；这里不许再开第二个 GSI 读者（票面第一条验收）。
 */
export function BoardApp(): React.ReactElement {
  const [snapshot, setSnapshot] = useState<MatchSnapshot | null>(null)
  const [now, setNow] = useState<number>(Date.now())

  useEffect(() => {
    let alive = true
    const tick = (): void => {
      void window.api
        .matchSnapshot()
        .then((next) => {
          if (!alive) return
          setSnapshot(next)
          setNow(Date.now())
        })
        .catch(() => {
          // 拿不到就当没有快照：界面已经是「先把 GSI 那条连通」，不需要第二套错误文案。
          if (alive) setSnapshot(null)
        })
    }
    tick()
    const timer = setInterval(tick, POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [])

  const view = boardView(snapshot, now)

  return (
    <div className="board">
      <div className="board-head">
        <span className="board-dot" data-tone={view.empty ? 'dim' : 'ok'} />
        <span className="board-title">对局看板</span>
      </div>
      {view.empty ? (
        <p className="board-empty">{view.headline}</p>
      ) : (
        <div className="board-grid">
          {view.rows.map((row) => (
            <div className="board-cell" key={row.key}>
              <span className="board-label">{row.label}</span>
              <span className="board-value" data-tone={row.tone}>
                {row.value}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
