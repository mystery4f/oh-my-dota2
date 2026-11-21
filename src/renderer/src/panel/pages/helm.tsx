import React, { useCallback, useEffect, useState } from 'react'
import type { OverlayStatus } from '@shared/ipc'
import type { MatchSnapshot } from '@shared/match-snapshot'
import type { MatchTimelineView } from '@shared/match-timeline'
import type { MicHealthEvent } from '@shared/mic-health'
import type { SpeakerChannels } from '@shared/speaker-channel'
import { UNBOUND_LABEL, formatAccelerator } from '@shared/hotkeys'
import {
  HELM_ACTION_BUSY,
  helmActions,
  helmChannelsView,
  helmHead,
  helmChainLine,
  helmHotkeyHints,
  helmListenLine,
  muteToggle
} from '@shared/helm'
import type { VoiceChainLast } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { useSettings } from '../use-settings'
import { Group, Row, StatusPill } from '../components/primitives'

/**
 * 驾驶室（#161 第一片 + #165 第二片）：抬头事实行、三个固定动作、监听行、频道列表、热键提示。
 *
 * 只读真数据：`matchSnapshot()`、`speakerChannels()`、`captureStatus().gsi.lastAt`、`matchTimeline()`、
 * `overlayStatus()`、`settings`，录音真值来自浮层上报的 `onMicHealth`。
 *
 * 判定全在 `@shared/helm`：这里只渲染，不写「matchid 是不是 0」这类判断，也不硬编码任何快捷键。
 * 空态三句互不冒充：没快照 / 没帧 / 没事件；失败态（captureStatus 抛错）另给一句。
 */
export function HelmPage(): React.ReactElement {
  const [snapshot, setSnapshot] = useState<MatchSnapshot | null>(null)
  const [channels, setChannels] = useState<SpeakerChannels | null>(null)
  const [timeline, setTimeline] = useState<MatchTimelineView | null>(null)
  const [overlay, setOverlay] = useState<OverlayStatus | null>(null)
  const [lastAt, setLastAt] = useState<number | null>(null)
  const [captureError, setCaptureError] = useState<string | null>(null)
  const { settings, update } = useSettings()
  const [recording, setRecording] = useState(false)
  const [looking, setLooking] = useState(false)
  const [busyNote, setBusyNote] = useState<string | null>(null)
  const [lastLook, setLastLook] = useState<string | null>(null)
  const [chainLast, setChainLast] = useState<VoiceChainLast | null>(null)
  const [chainError, setChainError] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(async (): Promise<void> => {
    const [snap, spk, cap, line, ov] = await Promise.all([
      window.api.matchSnapshot().catch(() => null),
      window.api.speakerChannels().catch(() => null),
      window.api
        .captureStatus()
        .then((status) => ({ lastAt: status?.gsi?.lastAt ?? null, error: null as string | null }))
        .catch((err: unknown) => ({ lastAt: null, error: err instanceof Error ? err.message : String(err) })),
      window.api.matchTimeline().catch(() => null),
      window.api.overlayStatus().catch(() => null)
    ])
    setSnapshot(snap)
    setChannels(spk)
    setLastAt(cap.lastAt)
    setCaptureError(cap.error)
    setTimeline(line)
    setOverlay(ov)
    setNow(Date.now())
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(timer)
  }, [refresh])

  // 录音真值只来自浮层的采集上报（#96 那条），面板不自己猜。
  useEffect(() => window.api.onMicHealth((event: MicHealthEvent) => setRecording(event.recording)), [])
  // 一句话链：广播只负责「有新的一条了」，真正的归属（哪一局）只问读口。
  useEffect(() => {
    const read = (): void => {
      window.api
        .voiceChainLast()
        .then((last) => {
          setChainLast(last)
          setChainError(null)
        })
        .catch((err: unknown) => setChainError(err instanceof Error ? err.message : String(err)))
    }
    read()
    return window.api.onVoiceChainResult(read)
  }, [])

  const head = helmHead(snapshot, lastAt, now)
  const view = helmChannelsView(channels?.channels ?? [], settings?.ttsMuteHeroes ?? [])
  const hints = settings === null ? [] : helmHotkeyHints(settings.hotkeys, formatAccelerator, UNBOUND_LABEL)
  const chain = helmChainLine({
    latest: chainLast === null ? null : { ...chainLast.summary, matchid: chainLast.matchid },
    snapshotMatchId: snapshot?.matchid ?? null,
    readError: chainError
  })
  const toggleMute = useCallback(
    (hero: string): void => {
      const result = muteToggle(settings?.ttsMuteHeroes ?? [], hero)
      // 没变（空名/本来就是那样）就不落盘：一次多余保存=主进程多一次归一化写盘。
      if (!result.changed) return
      void update({ ttsMuteHeroes: result.next })
    },
    [settings, update]
  )
  const listen = helmListenLine({
    gsiLastAt: captureError === null ? lastAt : null,
    now,
    captureError,
    snapshotMatchId: snapshot?.matchid ?? null,
    timeline
  })
  const actions =
    settings === null
      ? []
      : helmActions({
          hotkeys: settings.hotkeys,
          display: formatAccelerator,
          unboundLabel: UNBOUND_LABEL,
          overlayVisible: overlay?.visible === true,
          recording,
          looking,
          captureBusy: busyNote === HELM_ACTION_BUSY
        })

  const runAction = useCallback(
    async (id: 'voiceCapture' | 'visionAsk' | 'overlayPanel'): Promise<void> => {
      if (id === 'voiceCapture') {
        const result = await window.api.voiceCaptureToggle().catch(() => ({ sent: false }))
        setBusyNote(result.sent ? null : HELM_ACTION_BUSY)
        if (result.sent) window.setTimeout(() => setBusyNote(null), 600)
        return
      }
      if (id === 'overlayPanel') {
        await window.api.overlayPanelToggle().catch(() => null)
        setNow(Date.now())
        return
      }
      // 看一眼是花钱的调用：跑着的时候按钮禁用（纯缝按 looking 关），连点不会再来一次。
      setLooking(true)
      setLastLook('正在看…')
      try {
        const answer = await window.api.visionAsk()
        setLastLook(answer.ok ? answer.text : (answer.error ?? '没看成，原因不明'))
      } catch (err) {
        setLastLook(err instanceof Error ? err.message : String(err))
      } finally {
        setLooking(false)
        setNow(Date.now())
      }
    },
    []
  )

  return (
    <>
      <Group label="这一局">
        {head.empty ? (
          <Row label="连接" stacked>
            <span className="text-sm text-muted-foreground">{head.line}</span>
          </Row>
        ) : (
          <Row
            label="这一局"
            note={
              <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-sm">
                {head.facts.map((one) => (
                  <span key={one.id} className="truncate" title={`${one.label} ${one.value}`}>
                    <span className="text-muted-foreground">{one.label} </span>
                    <span className={one.value === '—' ? 'text-muted-foreground' : ''}>{one.value}</span>
                  </span>
                ))}
              </div>
            }
          />
        )}
      </Group>

      <Group label="动作">
        {actions.length === 0 ? (
          <Row label="动作" stacked>
            <span className="text-sm text-muted-foreground">设置还没读到</span>
          </Row>
        ) : (
          actions.map((one) => (
            <Row key={one.id} label={one.label} hint={one.key} note={one.note}>
              <Button
                size="sm"
                variant="outline"
                disabled={!one.enabled}
                onClick={() => void runAction(one.id)}
              >
                {one.label}
              </Button>
            </Row>
          ))
        )}
        {lastLook === null ? null : (
          <Row label="看了一眼" stacked>
            <span className="block max-w-full truncate text-sm text-muted-foreground" title={lastLook}>
              {lastLook}
            </span>
          </Row>
        )}
      </Group>

      <Group label="它在听什么 / 刚说了什么">
        <Row label="它在听什么" note={listen.left.text}>
          <StatusPill tone={listen.left.tone === 'ok' ? 'ready' : listen.left.tone === 'dim' ? 'idle' : 'warn'}>
            {listen.left.text}
          </StatusPill>
        </Row>
        <Row label="刚说了什么" note={listen.right.text}>
          <StatusPill tone={listen.right.tone === 'ok' ? 'ready' : 'idle'}>{listen.right.text}</StatusPill>
        </Row>
      </Group>

      <Group label="一句话链">
        {chain.empty === null ? (
          <>
            <Row label="听到" note={chain.heard.text}>
              {chain.heard.tone === 'bad' ? <StatusPill tone="warn">没听清</StatusPill> : null}
            </Row>
            <Row label="说了" note={chain.said.text}>
              {chain.said.tone === 'bad' ? <StatusPill tone="warn">没有译文</StatusPill> : null}
            </Row>
            {chain.failure === null ? null : (
              <Row label="卡住" stacked>
                <span className="text-xs text-muted-foreground">{chain.failure}</span>
              </Row>
            )}
          </>
        ) : (
          <Row label="链" stacked>
            <span className="text-sm text-muted-foreground">{chain.empty}</span>
          </Row>
        )}
      </Group>

      <Group label="谁在说话">
        {view.rows.length === 0 ? (
          <Row label="频道" stacked>
            <span className="text-sm text-muted-foreground">{view.line}</span>
          </Row>
        ) : (
          view.rows.map((row) => (
            <Row
              key={row.slot}
              label={row.label}
              hint={`${row.spoken} 句`}
              note={
                <span className="block max-w-full truncate" title={row.lastText}>
                  {row.lastText}
                </span>
              }
            >
              {row.muteable ? (
                <span className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    className="accent-amber-500"
                    checked={row.muted}
                    onChange={() => toggleMute(row.hero)}
                    aria-label={`单独静音 ${row.label}`}
                  />
                  <StatusPill tone={row.muted ? 'idle' : 'ready'}>{row.muted ? '已静音' : '在读'}</StatusPill>
                </span>
              ) : null}
            </Row>
          ))
        )}
      </Group>

      {view.note === '' ? null : (
        <Group label="按人静音">
          <Row label="为什么没有开关" stacked>
            <span className="text-xs text-muted-foreground">{view.note}</span>
          </Row>
        </Group>
      )}

      <Group label="热键">
        <Row
          label="按键"
          note={
            <div className="grid grid-cols-3 gap-x-4 gap-y-1 text-sm">
              {hints.map((one) => (
                <span key={one.id} className="truncate" title={`${one.label} ${one.key}`}>
                  <span className="text-muted-foreground">{one.label} </span>
                  <span className={one.unbound ? 'text-muted-foreground' : ''}>{one.key}</span>
                </span>
              ))}
            </div>
          }
        />
      </Group>
    </>
  )
}