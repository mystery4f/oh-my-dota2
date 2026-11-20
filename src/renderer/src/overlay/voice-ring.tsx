import { useEffect, useState } from 'react'
import { voiceRingView, type VoiceRingView } from '@shared/voice-ring'
import { subscribeVoiceRing, voiceRingSignal } from './voice-ring-store'

/**
 * 对讲三态环（#94）：一个 14px 的小圆圈，形状区分状态——空心=空闲、实心=录音中、两道弧=朗读中。
 *
 * 位置在浮层底部那条阶段行里（不悬浮、不覆盖聊天文本），理由：那是浮层唯一既有、又永远不被
 * 聊天行占用的地方；把它做成浮层角标就会压到正文最下面一行。
 */
export function VoiceRing(): React.ReactElement | null {
  const [view, setView] = useState<VoiceRingView>(() => voiceRingView(voiceRingSignal()))

  useEffect(() => {
    const sync = (): void => setView(voiceRingView(voiceRingSignal()))
    sync()
    return subscribeVoiceRing(sync)
  }, [])

  // 空闲不画：一个常驻的空圈对局里只是噪音，而且会让人以为「它卡住了」。
  if (view.state === 'idle') return null

  return (
    <span
      className={`voice-ring voice-ring-${view.shape}${view.pulse ? ' voice-ring-pulsing' : ''}`}
      role="img"
      aria-label={view.aria}
      title={view.aria}
    >
      <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true">
        {view.shape === 'filled' ? <circle cx="8" cy="8" r="5.5" /> : null}
        {view.shape === 'hollow' ? <circle cx="8" cy="8" r="5.5" fill="none" strokeWidth="1.5" /> : null}
        {view.shape === 'waves' ? (
          <>
            <path d="M4.5 4.5a5 5 0 0 1 0 7" fill="none" strokeWidth="1.6" />
            <path d="M8 3a7 7 0 0 1 0 10" fill="none" strokeWidth="1.6" />
          </>
        ) : null}
      </svg>
      <span className="voice-ring__label">{view.label}</span>
    </span>
  )
}