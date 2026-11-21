import React, { useCallback, useEffect, useState } from 'react'
import type { AppSettings } from '@shared/ipc'
import type { MatchSnapshot } from '@shared/match-snapshot'
import type { SpeakerChannels } from '@shared/speaker-channel'
import { UNBOUND_LABEL, formatAccelerator } from '@shared/hotkeys'
import { helmChannelsView, helmHead, helmHotkeyHints } from '@shared/helm'
import { Group, Row, StatusPill } from '../components/primitives'

/**
 * 驾驶室第一片（#161）：抬头事实行 + 频道列表 + 三个热键提示。
 *
 * 只读真数据：`matchSnapshot()`、`speakerChannels()`、`captureStatus().gsi.lastAt`、`settings`。
 * 空态文案全部来自 `@shared/helm`（照抄 #160），这里不许另编一句；控件只放在真有得控的地方——
 * 拿不到别人英雄名时就没有静音开关，页尾一句话解释为什么。
 */
export function HelmPage(): React.ReactElement {
  const [snapshot, setSnapshot] = useState<MatchSnapshot | null>(null)
  const [channels, setChannels] = useState<SpeakerChannels | null>(null)
  const [lastAt, setLastAt] = useState<number | null>(null)
  const [settings, setSettings] = useState<AppSettings | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const refresh = useCallback(async (): Promise<void> => {
    const [snap, spk, cap, cfg] = await Promise.all([
      window.api.matchSnapshot().catch(() => null),
      window.api.speakerChannels().catch(() => null),
      window.api.captureStatus().catch(() => null),
      window.api.getSettings().catch(() => null)
    ])
    setSnapshot(snap)
    setChannels(spk)
    setLastAt(cap?.gsi?.lastAt ?? null)
    setSettings(cfg)
    setNow(Date.now())
  }, [])

  useEffect(() => {
    void refresh()
    const timer = window.setInterval(() => void refresh(), 3000)
    return () => window.clearInterval(timer)
  }, [refresh])

  const head = helmHead(snapshot, lastAt, now)
  const view = helmChannelsView(channels?.channels ?? [], settings?.ttsMuteHeroes ?? [])
  const hints = settings === null ? [] : helmHotkeyHints(settings.hotkeys, formatAccelerator, UNBOUND_LABEL)

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
                <StatusPill tone={row.muted ? 'idle' : 'ready'}>{row.muted ? '已静音' : '在读'}</StatusPill>
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
