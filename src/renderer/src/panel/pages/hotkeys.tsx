import { useEffect, useState } from 'react'
import {
  HOTKEY_ACTIONS,
  chordFromKeyEvent,
  findHotkeyConflicts,
  formatAccelerator,
  normalizeHotkeyMap,
  type HotkeyActionId,
  type HotkeyMap,
  type HotkeyVerdict
} from '@shared/hotkeys'
import type { HotkeysResult } from '@shared/ipc'
import { Button } from '@/components/ui/button'
import { Group, Panel, Row, StatusPill } from '../components/primitives'

/**
 * 热键页：整张表一起改、一起存（注册也按整表重做）。
 * 录制 / 撞键拦存 / 被占用标注三件事与旧 HotkeyCard 完全一致，
 * 只是行排版换成 v2 的 Row。
 */

const VERDICT_TONE: Record<HotkeyVerdict, 'ready' | 'bad' | 'idle'> = {
  accepted: 'ready',
  rejected: 'bad',
  unbound: 'idle'
}

const VERDICT_TEXT: Record<HotkeyVerdict, string> = {
  accepted: '生效',
  rejected: '被占用',
  unbound: '未绑定'
}

export function HotkeysPage(): React.ReactElement {
  const [state, setState] = useState<HotkeysResult | null>(null)
  const [draft, setDraft] = useState<HotkeyMap>(() => normalizeHotkeyMap({}))
  const [capturing, setCapturing] = useState<HotkeyActionId | null>(null)
  const [pending, setPending] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void window.api.getHotkeys().then((next) => {
      setState(next)
      setDraft(mapFromState(next))
    })
  }, [])

  // 录制：监听一次全局按键。捕获阶段拦下，免得按键漏到面板其它控件上。
  useEffect(() => {
    if (!capturing) return
    const onKeyDown = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      if (event.key === 'Escape') {
        setCapturing(null)
        setPending('')
        return
      }
      const chord = chordFromKeyEvent({
        key: event.key,
        ctrlKey: event.ctrlKey,
        altKey: event.altKey,
        shiftKey: event.shiftKey,
        metaKey: event.metaKey
      })
      if (!chord.complete) {
        setPending(chord.pending)
        return
      }
      if (chord.problem === 'need-modifier') {
        setError(`${chord.accelerator} 会抢走游戏里打字，至少加 Ctrl/Alt/Shift/Win 之一`)
        return
      }
      setError(null)
      setDraft((prev) => ({ ...prev, [capturing]: chord.accelerator }))
      setCapturing(null)
      setPending('')
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [capturing])

  const conflicts = findHotkeyConflicts(draft)
  const conflictIds = new Set<HotkeyActionId>(conflicts.flatMap((item) => item.ids))
  const conflictKeys = [...new Set(conflicts.map((item) => item.accelerator))]
  const dirty =
    state !== null &&
    state.actions.some((item) => draft[item.id] !== state.actions.find((each) => each.id === item.id)?.accelerator)

  const save = async (): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const next = await window.api.setHotkeys(draft)
      setState(next)
      if (next.error) setError(next.error)
      else setDraft(mapFromState(next))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel>
      <Group label="动作键位">
        {HOTKEY_ACTIONS.map((action) => {
          const accelerator = draft[action.id]
          const current = state?.actions.find((item) => item.id === action.id)
          const saved = current?.accelerator ?? ''
          const changed = accelerator !== saved
          const verdict: HotkeyVerdict | null = conflictIds.has(action.id)
            ? 'rejected'
            : changed
              ? null
              : (current?.verdict ?? 'unbound')
          const isCapturing = capturing === action.id
          return (
            <Row
              key={action.id}
              label={action.label}
              hint={action.hint}
            >
              <Button
                variant={isCapturing ? 'default' : 'outline'}
                size="sm"
                className="w-40 justify-center font-mono text-xs"
                onClick={() => {
                  setCapturing(isCapturing ? null : action.id)
                  setPending('')
                  setError(null)
                }}
              >
                {isCapturing ? (pending || '按下组合键…') : formatAccelerator(accelerator)}
              </Button>
              <StatusPill tone={verdict ? VERDICT_TONE[verdict] : 'idle'}>
                {conflictIds.has(action.id) ? '撞键' : verdict ? VERDICT_TEXT[verdict] : '未保存'}
              </StatusPill>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDraft((prev) => ({ ...prev, [action.id]: '' }))}
                title="这个动作不要全局热键（面板按钮仍然可用）"
              >
                不绑
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setDraft((prev) => ({ ...prev, [action.id]: action.defaultAccelerator }))}
              >
                默认
              </Button>
            </Row>
          )
        })}
      </Group>

      <Group label="整表">
        <Row
          label="保存热键表"
          hint={
            conflictKeys.length > 0
              ? `两个动作不能用同一个键：${conflictKeys.join('、')}。改掉冲突的那一行再保存。`
              : '保存后立刻重新注册，不用重启；被占用的键会在那一行标红'
          }
        >
          <Button onClick={() => void save()} disabled={busy || conflictKeys.length > 0 || !dirty}>
            {busy ? '保存中…' : '保存'}
          </Button>
          {dirty ? <span className="text-xs text-muted-foreground">有未保存的改动</span> : null}
        </Row>
        {error ? (
          <Row label="错误">
            <p className="text-xs text-destructive">{error}</p>
          </Row>
        ) : null}
      </Group>
    </Panel>
  )
}

/** 主进程回的状态表 → 面板编辑用的整张表。 */
function mapFromState(state: HotkeysResult): HotkeyMap {
  return normalizeHotkeyMap(
    state.actions.reduce<Record<string, string>>((acc, item) => {
      acc[item.id] = item.accelerator
      return acc
    }, {})
  )
}
