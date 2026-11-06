import type { OverlayStatus } from '@shared/ipc'
import { beginDrag } from './drag'

/** 未锁定时的工具条：拖把手 + 几何标签 + 还原/朗读/收起/锁定。锁定后整条消失。 */
export function Toolbar(props: { status: OverlayStatus; onStatus: (s: OverlayStatus) => void }): JSX.Element {
  const { status, onStatus } = props
  const width = Math.round(status.geometry.width)
  const height = Math.round(status.geometry.height)
  return (
    <div
      id="bar"
      onPointerDown={(event) => {
        if (event.target instanceof HTMLButtonElement) return
        beginDrag(status, 'move', event.nativeEvent, onStatus)
      }}
      onDoubleClick={() => void window.api.overlaySetLocked(!status.locked).then(onStatus)}
    >
      <span id="bar-label">未锁定 · {width}×{height}（5 秒后自动锁定）</span>
      <button type="button" onClick={() => void window.api.overlayResetGeometry().then(onStatus)}>
        还原
      </button>
      <button
        type="button"
        className={status.readAloud ? undefined : 'dim-btn'}
        onClick={() => void window.api.overlaySetVoice(!status.readAloud).then(onStatus)}
      >
        朗读：{status.readAloud ? '开' : '关'}
      </button>
      <button type="button" onClick={() => void window.api.overlayToggleCollapse().then(onStatus)}>
        收起
      </button>
      <button type="button" onClick={() => void window.api.overlaySetLocked(true).then(onStatus)}>
        锁定
      </button>
    </div>
  )
}
