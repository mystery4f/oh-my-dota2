import type { OverlayStatus } from '@shared/ipc'
import { beginDrag, consumeDragMoved } from './drag'

/** 收起后的整窗小图标：点一下展开，未锁定时可以直接拖走；未读数亮一个小点。 */
export function MiniIcon(props: { status: OverlayStatus; unread: number; onStatus: (s: OverlayStatus) => void }): JSX.Element {
  const { status, unread, onStatus } = props
  return (
    <button
      id="mini"
      type="button"
      onPointerDown={(event) => beginDrag(status, 'move', event.nativeEvent, onStatus)}
      onClick={() => {
        if (consumeDragMoved()) return
        void window.api.overlayToggleCollapse().then(onStatus)
      }}
    >
      <span className="mini-lock">{status.locked ? '🔒' : '🔓'}</span>
      <span>翻译区</span>
      {unread > 0 && <span className="unread">{unread > 99 ? '99+' : unread}</span>}
    </button>
  )
}
