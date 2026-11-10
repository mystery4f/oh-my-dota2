import { useCallback, useEffect, useRef, useState } from 'react'
import type React from 'react'
import type { CaptureEntry, OverlayStatus, VoiceChainSummary } from '@shared/ipc'
import { fadeRows, nextUnread, pushEntry, type LedgerRow } from '@shared/overlay-ledger'
import type { SpokenStatus } from '@shared/voice-out'
import { formatStageTrace } from '@shared/voice-stage'
import { ChatRows } from './chat-rows'
import { beginDrag } from './drag'
import { MiniIcon } from './mini-icon'
import { SummonPanel } from './summon-panel'
import { Toolbar } from './toolbar'
import { subscribeSpeech } from './speech'
import { createVoiceCapture, type VoiceRowPatch } from './voice-capture'
import { bindStage, setStage } from './stage'


/**
 * 浮层渲染根：状态都从主进程下来（overlayStatus + 状态广播），
 * 消息行走共享账本（overlay-ledger 纯函数），这里只做装配。
 */
export function App(): JSX.Element {
  const [status, setStatus] = useState<OverlayStatus | null>(null)
  const [rows, setRows] = useState<LedgerRow[]>([])
  const [unread, setUnread] = useState(0)
  const [spokenById, setSpokenById] = useState<Record<string, SpokenStatus>>({})
  /** 对讲行的阶段留痕：主进程每完成一段发一份快照，这里只格式化，渲染端不自己算时间。 */
  const [traceById, setTraceById] = useState<Record<string, string>>({})
  const [stage, setStageText] = useState<string | null>(null)

  useEffect(() => {
    bindStage(setStageText)
    return () => bindStage(null)
  }, [])

  useEffect(() => {
    // 快照式事件：掉一条只是少画一次，行上始终是最近一次的完整状态。
    return window.api.onVoiceStage((event) => {
      setTraceById((current) => {
        const next = { ...current }
        // 播完也不清：清掉会让这行在 patch 到达前退回「翻译中…」，正是它刚刚走过的阶段。
        // 走完的那份快照只剩各段耗时（current 为 done 时 formatStageTrace 不画进行中标签）。
        next[event.rowId] = formatStageTrace(event)
        return next
      })
    })
  }, [])

  const onStatus = useCallback((next: OverlayStatus): void => setStatus(next), [])

  /** 收到任何一批消息：进账本；收起且面板没开才计未读。 */
  const acceptBatch = useCallback((batch: CaptureEntry[]): void => {
    setRows((current) => batch.reduce(pushEntry, current))
    setUnread((current) => batch.reduce((c) => nextUnread(c, true, true), current))
  }, [])

  const acceptUpdate = useCallback((batch: CaptureEntry[]): void => {
    setRows((current) => batch.reduce(pushEntry, current))
  }, [])

  /** 手动触发是「拍一张照」：先清空再重建，避免旧行残留。 */
  const acceptReplace = useCallback((batch: CaptureEntry[]): void => {
    setRows(() => batch.reduce(pushEntry, [] as LedgerRow[]))
    setStage(batch.length === 0 ? '没有识别到聊天内容' : `已刷新 ${batch.length} 条`, 1500)
  }, [])

  // 初始状态 + 状态广播：一条线进 React，没有任何轮询。
  useEffect(() => {
    void window.api.overlayStatus().then(onStatus)
    const off = window.api.onOverlayState(onStatus)
    return off
  }, [onStatus])

  useEffect(() => {
    const offEntries = window.api.onCaptureEntries(acceptBatch)
    const offUpdate = window.api.onCaptureUpdate(acceptUpdate)
    const offReplace = window.api.onCaptureReplace(acceptReplace)
    return () => {
      offEntries()
      offUpdate()
      offReplace()
    }
  }, [acceptBatch, acceptUpdate, acceptReplace])

  // 展开或呼出面板时未读清零：看得到行的地方不需要红点。
  useEffect(() => {
    if (!status) return
    if (!status.collapsed || status.panelOpen) setUnread(0)
  }, [status])

  // 渐隐每秒算一次：12 秒前的行降为 25% 不透明，保留上下文但不占视野。
  useEffect(() => {
    const timer = setInterval(() => {
      setRows((current) => fadeRows(current, Date.now()))
    }, 1000)
    return () => clearInterval(timer)
  }, [])

  // 状态的镜像引用：给只创建一次的回调读最新值（录音阶段行的键名、锁判断）。
  const statusRef = useRef<OverlayStatus | null>(null)
  useEffect(() => {
    statusRef.current = status
  }, [status])

  // 朗读与录音热键：toggle 由主进程广播下来，这里真的动麦克风。
  const captureRef = useRef<ReturnType<typeof createVoiceCapture> | null>(null)
  useEffect(() => {
    captureRef.current = createVoiceCapture({
      pushRow: (entry) => setRows((current) => pushEntry(current, entry)),
      patchRow: (patch: VoiceRowPatch) => {
        setRows((current) =>
          current.map((row) =>
            row.id === patch.id
              ? {
                  ...row,
                  translated: patch.translated !== undefined ? patch.translated : row.translated,
                  error: patch.error !== undefined ? patch.error : row.error,
                  pending: false
                }
              : row
          )
        )
        // 这一行已经有结论（译文 / 错误）：阶段后缀收掉，别让它挂着一个过期的「合成中…」。
        setTraceById((current) => {
          if (current[patch.id] === undefined) return current
          const next = { ...current }
          delete next[patch.id]
          return next
        })
        if (patch.spoken !== undefined) {
          const spoken = patch.spoken
          setSpokenById((current) => ({ ...current, [patch.id]: spoken }))
        }
      },
      stage: setStage,
      reportChain: (result: VoiceChainSummary) => window.api.reportVoiceChain(result),
      voiceCaptureKey: () => statusRef.current?.hotkeys.voiceCapture ?? '',
      voiceCaptureMode: () => statusRef.current?.voiceCaptureMode ?? 'hold'
    })
    const offSpeech = subscribeSpeech()
    const offToggle = window.api.onVoiceRecordToggle(() => captureRef.current?.toggle())
    // 按住模式：主进程的常驻键盘监视给出按下/松开两条，分别走 start / stop。
    const offStart = window.api.onVoiceRecordStart(() => captureRef.current?.start())
    const offStop = window.api.onVoiceRecordStop(() => captureRef.current?.stop())
    return () => {
      offSpeech()
      offToggle()
      offStart()
      offStop()
    }
  }, [])

  // 配置态方向键微调：Shift = 10px 步进；锁定时什么都不吃（反正穿透）。
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const current = statusRef.current
      if (!current || current.locked || current.panelOpen) return
      const step = event.shiftKey ? 10 : 1
      const delta =
        event.key === 'ArrowLeft'
          ? { dx: -step, dy: 0 }
          : event.key === 'ArrowRight'
            ? { dx: step, dy: 0 }
            : event.key === 'ArrowUp'
              ? { dx: 0, dy: -step }
              : event.key === 'ArrowDown'
                ? { dx: 0, dy: step }
                : null
      if (!delta) return
      event.preventDefault()
      void window.api.overlayNudge(delta.dx, delta.dy).then(onStatus)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onStatus])

  // 配置态闲置倒计时由主进程管；这边只要把「还在动」告诉它，1 秒一次足够。
  useEffect(() => {
    let lastAlive = 0
    const onMove = (): void => {
      if (statusRef.current?.locked) return
      const now = Date.now()
      if (now - lastAlive < 1000) return
      lastAlive = now
      void window.api.overlayKeepAlive()
    }
    window.addEventListener('pointermove', onMove)
    return () => window.removeEventListener('pointermove', onMove)
  }, [])

  if (!status) return <div id="root-inner" />
  const collapsed = status.collapsed && !status.panelOpen
  return (
    <div
      id="root-inner"
      data-locked={status.locked ? 'true' : 'false'}
      data-collapsed={collapsed ? 'true' : 'false'}
      data-panel={status.panelOpen ? 'true' : 'false'}
      style={{ '--row-alpha': String(status.opacity ?? 0.34) } as React.CSSProperties}
    >
      {status.panelOpen ? (
        <SummonPanel status={status} onStatus={onStatus} />
      ) : collapsed ? (
        <MiniIcon status={status} unread={unread} onStatus={onStatus} />
      ) : (
        <>
          {!status.locked && <Toolbar status={status} onStatus={onStatus} />}
          <ChatRows rows={rows} spokenById={spokenById} traceById={traceById} status={status} />
          <StageLine status={status} stage={stage} />
          {!status.locked && (
            <>
              <div id="resize-left" onPointerDown={(e) => beginDrag(status, 'left', e.nativeEvent, onStatus)} />
              <div id="resize-right" onPointerDown={(e) => beginDrag(status, 'right', e.nativeEvent, onStatus)} />
            </>
          )}
        </>
      )}
    </div>
  )
}

/** 阶段行：文案来源的优先级已在 setStage 与 status 里排好，这里只负责画。 */
function StageLine(props: { status: OverlayStatus; stage: string | null }): JSX.Element | null {
  if (props.stage !== null) return <div id="stage">{props.stage}</div>
  if (props.status.hint) return <div id="stage" className="warn">{props.status.hint}</div>
  if (!props.status.locked) return <div id="stage">未锁定 · 可拖动（5 秒后自动锁定）</div>
  return null
}
