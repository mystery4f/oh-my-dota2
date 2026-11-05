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
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'

/**
 * 热键管理：整张表一起改、一起存。
 *
 * 三个必须做到的事：
 * 一是能改——点一下动作旁边的键，按下新组合就录进来；
 * 二是撞键当场拦——两个动作共用一个键就整张表不许存，行标红；
 * 三是抢不到要说——注册失败（别的软件占着）在行上直接标出来，不能只在日志里。
 */

const VERDICT_TEXT: Record<HotkeyVerdict, string> = {
  accepted: '生效',
  rejected: '被占用',
  unbound: '未绑定'
}

const VERDICT_VARIANT: Record<HotkeyVerdict, 'default' | 'destructive' | 'secondary'> = {
  accepted: 'default',
  rejected: 'destructive',
  unbound: 'secondary'
}

export function HotkeyCard(): React.ReactElement {
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
    <Card>
      <CardHeader>
        <CardTitle>热键</CardTitle>
        <CardDescription>
          全局热键在游戏里有焦点时也生效。点键位开始录制，按 Esc 取消；同一个键不能给两个动作用。
          抢不到的键通常是别的软件（输入法、剪辑工具、游戏助手）先占了，换一个就行。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="divide-y divide-border/60 rounded-md border border-border/60">
          {HOTKEY_ACTIONS.map((action) => {
            const accelerator = draft[action.id]
            const current = state?.actions.find((item) => item.id === action.id)
            // 改过还没存的行不能显示上一次的注册结果：那个结果是旧键的。
            const saved = current?.accelerator ?? ''
            const changed = accelerator !== saved
            const verdict: HotkeyVerdict | null = conflictIds.has(action.id)
              ? 'rejected'
              : changed
                ? null
                : (current?.verdict ?? 'unbound')
            const isCapturing = capturing === action.id
            return (
              <div key={action.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <div className="min-w-48 flex-1">
                  <div className="text-sm">{action.label}</div>
                  <div className="text-xs text-muted-foreground">{action.hint}</div>
                </div>
                <Button
                  variant={isCapturing ? 'default' : 'outline'}
                  className="w-40 justify-center font-mono text-xs"
                  onClick={() => {
                    setCapturing(isCapturing ? null : action.id)
                    setPending('')
                    setError(null)
                  }}
                >
                  {isCapturing ? (pending || '按下组合键…') : labelOf(accelerator)}
                </Button>
                <Badge variant={verdict ? VERDICT_VARIANT[verdict] : 'outline'}>
                  {conflictIds.has(action.id) ? '撞键' : verdict ? VERDICT_TEXT[verdict] : '未保存'}
                </Badge>
                <Button
                  variant="ghost"
                  className="text-xs"
                  onClick={() => setDraft((prev) => ({ ...prev, [action.id]: '' }))}
                  title="这个动作不要全局热键（面板按钮仍然可用）"
                >
                  不绑
                </Button>
                <Button
                  variant="ghost"
                  className="text-xs"
                  onClick={() => setDraft((prev) => ({ ...prev, [action.id]: action.defaultAccelerator }))}
                >
                  默认
                </Button>
              </div>
            )
          })}
        </div>

        {conflictKeys.length > 0 ? (
          <p className="text-xs text-destructive">
            两个动作不能用同一个键：{conflictKeys.join('、')}。改掉冲突的那一行再保存。
          </p>
        ) : null}
        {error ? <p className="text-xs text-destructive">{error}</p> : null}

        <div className="flex items-center gap-2">
          <Button onClick={() => void save()} disabled={busy || conflictKeys.length > 0 || !dirty}>
            {busy ? '保存中…' : '保存热键'}
          </Button>
          <Button
            variant="ghost"
            className="text-xs"
            onClick={() => setDraft(normalizeHotkeyMap({}))}
            disabled={busy}
          >
            全部恢复默认
          </Button>
          {dirty ? <span className="text-xs text-muted-foreground">有未保存的改动</span> : null}
        </div>
        <p className="text-xs text-muted-foreground">
          保存后立刻重新注册，不用重启。被占用的键会在这一行标红——那就是「按了没反应」的真正原因。
        </p>
      </CardContent>
    </Card>
  )
}

/** 面板里的写法统一走 formatAccelerator：Super 显示成 Win，空串显示成「未绑定」。 */
function labelOf(accelerator: string): string {
  return formatAccelerator(accelerator)
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
