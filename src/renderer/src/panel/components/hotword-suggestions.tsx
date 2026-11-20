import { useCallback, useEffect, useMemo, useState } from 'react'
import { HOTWORD_LIMIT, parseHotwords } from '@shared/asr-hotwords'
import type { HotwordSuggestions } from '@shared/asr-hotword-candidates'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { errorMessage } from '@shared/errors'
import { useSaveFlash } from '../use-settings'

/**
 * 热词候选提案（issue #74）：把纠错样本里反复出现的差异词拎出来给人看，
 * 人点了「并入热词表」才写 `asrHotwords`——程序从不自动写。
 *
 * 三条面板规则都写在这里：
 * - 已经 `inTable` 的词默认不勾——再勾一遍表里已有的词，等于替程序去重；
 * - 合并是显式的：`added / already / dropped` 三个数先说出来再落盘，表满时被丢掉的词单独亮出来；
 * - 每次提交只调一次 `hotwordApply`：sherpa 热词是构造期配置，多写一次就多重载一次识别器。
 */
export function HotwordCandidateBox({
  enabled,
  onApplied
}: {
  enabled: boolean
  /** 并入成功后把新词表交给页面：`useSettings` 的 state 要跟上来，否则热词输入框还是旧值，一编辑就覆盖刚并入的词。 */
  onApplied?: (hotwords: string) => void
}): React.ReactElement {
  const [suggestions, setSuggestions] = useState<HotwordSuggestions | null>(null)
  // 勾选态是受控的：默认勾上不在表里的词，用户改勾后以此为准提交。
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // 表满时被丢下的词：note 里写了「见下」就必须真的列出来，否则那句提示是在骗人。
  const [dropped, setDropped] = useState<readonly string[]>([])
  // 展开了原句的词（#137）：证据算出来又丢掉，等于让人凭猜决定要不要改词表。
  const [revealed, setRevealed] = useState<ReadonlySet<string>>(new Set())
  const save = useSaveFlash()

  const refresh = useCallback((): void => {
    window.api
      .hotwordSuggestions()
      .then((next) => {
        setSuggestions(next)
        // 拉新清单时把勾选态重置成「默认勾上不在表里的词」——上一次的勾选只属于上一次的清单。
        setSelected(new Set(next.suggestions.filter((item) => !item.inTable).map((item) => item.word)))
      })
      .catch((err: unknown) => setNote(`候选清单读不出来：${errorMessage(err)}`))
  }, [])

  useEffect(refresh, [refresh])

  // 纠错完成 → 池子变了 → 重新拉清单；纠错在 talk 页完成，这里靠窗口聚焦兜底。
  useEffect(() => {
    const onFocus = (): void => refresh()
    window.addEventListener('focus', onFocus)
    return () => window.removeEventListener('focus', onFocus)
  }, [refresh])

  const chosen = Array.from(selected)
  const currentCount = useMemo(() => parseHotwords(suggestions?.hotwords ?? '').length, [suggestions])
  // 表满被丢下的词单列一行：这些词没进表，人得先删几个再重新并入。
  const droppedLine =
    dropped.length > 0 ? (
      <p className="text-xs text-amber-600">
        表满没写进去：{dropped.join('、')} —— 先在热词框里删几个，再勾上重并
      </p>
    ) : null
  const toggleSamples = (word: string): void => {
    setRevealed((prev) => {
      const next = new Set(prev)
      if (next.has(word)) next.delete(word)
      else next.add(word)
      return next
    })
  }

  const toggle = (word: string): void => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(word)) next.delete(word)
      else next.add(word)
      return next
    })
  }

const apply = async (): Promise<void> => {
    const words = chosen
    if (words.length === 0) {
      setNote('先勾几个词再并入。')
      return
    }
    setBusy(true)
    try {
      const result = await window.api.hotwordApply(words)
      onApplied?.(result.hotwords)
      const parts: string[] = []
      if (result.added.length > 0) parts.push(`加 ${result.added.length} 个`)
      if (result.already.length > 0) parts.push(`${result.already.length} 个已在表里`)
      if (result.dropped.length > 0) parts.push(`表满丢 ${result.dropped.length} 个（见下）`)
      setDropped(result.dropped)
      void save.wrap(Promise.resolve())
      setNote(
        parts.length > 0
          ? `已并入：${parts.join('、')}。识别器已重载，下一句录音生效。`
          : '没有可并入的词。'
      )
      refresh()
    } catch (err) {
      setNote(`并入失败：${errorMessage(err)}`)
    } finally {
      setBusy(false)
    }
  }

  const dismiss = (word: string): void => {
    void window.api
      .hotwordDismiss([word])
      .then(() => {
        setNote(`忽略「${word}」：计数保留在池子里，只是不再建议。`)
        refresh()
      })
      .catch((err: unknown) => setNote(`忽略失败：${errorMessage(err)}`))
  }

  if (!enabled) return <></>

  if (suggestions === null) {
    return <p className="text-xs text-muted-foreground">候选清单载入中…</p>
  }

if (suggestions.suggestions.length === 0) {
    // 并入后池子空了也会走到这里：反馈不能跟着候选一起消失，
    // 否则用户点完「并入」看不到任何确认。corrections===0 且没反馈才整体隐身。
    if (suggestions.corrections === 0 && !note && !save.flash && !save.error) return <></>
    return (
      <div className="space-y-2">
        {suggestions.corrections > 0 && !note && !save.flash ? (
          <p className="text-xs text-muted-foreground">
            攒了 {suggestions.corrections} 次纠错，但没凑出 ≥2 字的候选词：单字差异是噪声，不进池子。
          </p>
        ) : null}
        {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
        {droppedLine}
        {save.flash ? <p className="text-xs text-emerald-600">{save.flash}</p> : null}
        {save.error ? <p className="text-xs text-rose-500">{save.error}</p> : null}
      </div>
    )
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-[11px] uppercase tracking-wider text-muted-foreground">
          纠错候选 · {suggestions.corrections} 次纠错
        </span>
        <span className="text-xs text-muted-foreground">
          现役 {currentCount}/{HOTWORD_LIMIT}
        </span>
      </div>
      <ul className="space-y-1">
        {suggestions.suggestions.map((item) => {
          const open = revealed.has(item.word)
          return (
            <li key={item.word} className="space-y-1 text-xs">
              <div className="flex items-start gap-2">
                <label className="flex items-center gap-1.5">
                  <input
                    type="checkbox"
                    className="mt-0.5 size-3.5"
                    checked={selected.has(item.word)}
                    onChange={() => toggle(item.word)}
                  />
                  {/* 悬停给第一条原句：不想展开的人也能一眼看到它从哪句话里来 */}
                  <span
                    title={item.samples[0] ?? item.word}
                    className={cn('font-medium', item.inTable && 'text-muted-foreground line-through')}
                  >
                    {item.word}
                  </span>
                </label>
                <span className="text-muted-foreground">
                  ×{item.count}
                  {item.inTable ? ' · 已在表' : ''}
                </span>
                {item.samples.length > 0 ? (
                  <button
                    type="button"
                    aria-expanded={open}
                    className="text-muted-foreground underline-offset-2 hover:underline"
                    onClick={() => toggleSamples(item.word)}
                  >
                    {open ? '收起原句' : `原句 ${item.samples.length}`}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="text-muted-foreground underline-offset-2 hover:underline"
                  onClick={() => dismiss(item.word)}
                >
                  忽略
                </button>
              </div>
              {open ? (
                <ul className="ml-5 space-y-0.5 border-l border-border/60 pl-2 text-[11px] leading-relaxed text-muted-foreground">
                  {/* 同一句可能被纠错过两次（原句相同）：键带上序号，别让 React 丢掉一条证据 */}
                  {item.samples.map((sample, index) => (
                    <li key={`${item.word}-${index}`}>· {sample}</li>
                  ))}
                </ul>
              ) : null}
            </li>
          )
        })}
      </ul>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy || chosen.length === 0} onClick={() => void apply()}>
          并入热词表
        </Button>
        <span className="text-xs text-muted-foreground">
          勾选后一次写入；表满时被丢下的词会单独列出
        </span>
      </div>
      {note ? <p className="text-xs text-muted-foreground">{note}</p> : null}
      {droppedLine}
      {save.flash ? <p className="text-xs text-emerald-600">{save.flash}</p> : null}
      {save.error ? <p className="text-xs text-rose-500">{save.error}</p> : null}
    </div>
  )
}