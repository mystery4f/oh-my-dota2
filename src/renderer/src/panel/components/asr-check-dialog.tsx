import * as React from 'react'
import { summarizeAsrCheck, type AsrCheckItem, type AsrCheckState } from '@shared/train/asr-check'
import { formatCer, rankByCer, summarizeCerByCohort } from '@shared/train/cer'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { Modal } from './modal'

/**
 * 全量识别比对（验收）：把每条录音喂给现役模型，和稿子原文比。
 *
 * 结果只在主进程内存里，关掉弹层就丢——重跑一次约一分钟，不值得落库。
 *
 * 三件事按「先干什么」排：
 * · 两个 CER 分开报——训练里见过的（量记忆）与留出没见过的（量泛化）混在一起，等于自夸；
 * · 错得最狠的排最前，并给出「这一句可以点开重听、改答案」——排名不落到具体某一行的动作上就只是数字；
 * · 默认只列不一致：全对时不该让人翻八十几行去找「哪里错了」。
 */

function gradeText(grade: AsrCheckItem['grade']): string {
  if (grade === 'same') return '一致'
  return grade === 'near' ? '差一点' : '明显错'
}

function gradeClass(grade: AsrCheckItem['grade']): string {
  if (grade === 'same') return 'text-muted-foreground'
  return grade === 'near' ? 'text-amber-500' : 'text-red-400'
}

function cohortText(item: AsrCheckItem): string {
  if (item.cohort === 'train') return '训练里见过'
  return item.cohort === 'eval' ? '留出' : '未记切分'
}

function elapsedSeconds(state: AsrCheckState | null): number {
  if (!state) return 0
  const end = state.running ? Date.now() : state.finishedAt
  if (!state.startedAt) return 0
  return Math.max(0, Math.round((end - state.startedAt) / 1000))
}

/** `G14-L01` / `G99-T01` → 组与句：回放要拿这两个键去读录音。 */
function splitKey(key: string): { group: string; line: string } | null {
  const at = key.indexOf('-')
  if (at <= 0 || at === key.length - 1) return null
  return { group: key.slice(0, at), line: key.slice(at + 1) }
}

export function AsrCheckDialog({
  open,
  onClose
}: {
  open: boolean
  onClose: () => void
}): React.ReactElement {
  const [state, setState] = React.useState<AsrCheckState | null>(null)
  const [showAll, setShowAll] = React.useState(false)
  /** 正在编辑的答案（key → 文本）；没改过的行不出现在这里。 */
  const [draft, setDraft] = React.useState<Record<string, string>>({})
  const [note, setNote] = React.useState('')
  const [busy, setBusy] = React.useState('')
  const audio = React.useRef<HTMLAudioElement | null>(null)

  React.useEffect(() => {
    if (!open) return
    setShowAll(false)
    setDraft({})
    setNote('')
    void window.api.asrCheckStart().then(setState)
  }, [open])

  // 关掉弹层就掐掉回放，否则声音会在面板关掉之后还响着。
  React.useEffect(() => {
    if (open) return
    audio.current?.pause()
    audio.current = null
  }, [open])

  const running = state?.running ?? false
  React.useEffect(() => {
    if (!open || !running) return
    const timer = window.setInterval(() => {
      void window.api.asrCheckState().then(setState)
    }, 600)
    return () => window.clearInterval(timer)
  }, [open, running])

  const items = React.useMemo(() => state?.items ?? [], [state])
  const summary = summarizeAsrCheck(items)
  const cer = React.useMemo(() => summarizeCerByCohort(items), [items])
  const visible = React.useMemo(() => {
    const shown = showAll ? items : items.filter((item) => item.grade !== 'same')
    return rankByCer(shown)
  }, [items, showAll])

  const play = (item: AsrCheckItem): void => {
    const parts = splitKey(item.key)
    if (parts === null) {
      setNote(`${item.key} 不是「组-句」的形式，找不到录音`)
      return
    }
    setBusy(item.key)
    void window.api
      .ftRecRead(parts.group, parts.line)
      .then((bytes) => {
        // 用同一个 Audio 元素轮换 src：每行建一个新的会让上一次的回放停不下来。
        audio.current?.pause()
        const url = URL.createObjectURL(new Blob([bytes.buffer as ArrayBuffer], { type: 'audio/wav' }))
        const next = new Audio(url)
        audio.current = next
        next.onended = () => URL.revokeObjectURL(url)
        void next.play().catch(() => setNote(`${item.key} 放不出来（录音可能被删了）`))
      })
      .catch(() => setNote(`${item.key} 读不到录音文件`))
      .finally(() => setBusy(''))
  }

  const save = (item: AsrCheckItem): void => {
    const text = draft[item.key] ?? item.expected
    setBusy(item.key)
    void window.api
      .asrCheckCorrect(item.key, text)
      .then((result) => {
        if (!result.ok) {
          setNote(`没保存：${result.error ?? '原因不明'}`)
          return
        }
        setDraft((current) => {
          const next = { ...current }
          delete next[item.key]
          return next
        })
        setNote(`已写回账本：${item.key}（修订 ${result.revision ?? '?'}）`)
        return window.api.asrCheckState().then(setState)
      })
      .catch(() => setNote('没保存：写账本时出错了'))
      .finally(() => setBusy(''))
  }

  const cerLine = (label: string, value: { rows: number; cer: number; clean: number }): string =>
    value.rows === 0 ? `${label} 没有录音` : `${label} ${value.rows} 条 CER ${formatCer(value.cer)}（全对 ${value.clean}）`

  return (
    <Modal
      open={open}
      title="全量识别比对"
      hint="用现役模型把每条录音跑一遍，和稿子原文比；标点与空白不参与比较。关掉就丢，重跑一次约一分钟。"
      onClose={onClose}
    >
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-4 py-3">
        {running ? (
          <>
            <div className="text-xs text-muted-foreground">
              已完成 {state?.done ?? 0} / {state?.total ?? 0}
              {state?.current ? ` · 正在跑 ${state.current}` : ''}
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void window.api.asrCheckStop().then(setState)}
            >
              停止
            </Button>
          </>
        ) : (
          <>
            <div className="text-xs text-muted-foreground">
              {state?.error
                ? `识别中断：${state.error}`
                : `共 ${summary.total} 条 · 一致 ${summary.same} · 差一点 ${summary.near} · 明显错 ${summary.wrong} · ${elapsedSeconds(state)} 秒`}
            </div>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setShowAll((value) => !value)}>
                {showAll ? '只看不一致' : '显示全部'}
              </Button>
              <Button size="sm" variant="outline" onClick={() => void window.api.asrCheckStart().then(setState)}>
                重新识别
              </Button>
            </div>
          </>
        )}
      </div>

      {summary.total > 0 ? (
        <div className="space-y-1 border-b border-border/60 px-4 py-2.5 text-xs text-muted-foreground">
          {/* 两个数分开报：见过与没见过混在一起看，等于把泛化数字做假。 */}
          <div>{cerLine('训练里见过', cer.train)}</div>
          <div>{cerLine('留出没见过', cer.eval)}</div>
          {cer.unknown.rows > 0 ? <div className="opacity-70">{cerLine('未记切分', cer.unknown)}</div> : null}
        </div>
      ) : null}

      {!running && summary.total > 0 && summary.same === summary.total ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">全部一致</p>
      ) : null}

      {!running && !state?.error && summary.total === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">账本里还没有带标签的录音</p>
      ) : null}

      <ul className="divide-y divide-border/40">
        {visible.map((item) => (
          <li key={item.key} className="space-y-1 px-4 py-2.5">
            <div className="flex items-baseline justify-between gap-3">
              <span className="font-mono text-xs text-muted-foreground">
                {item.key}
                <span className="ml-2 font-sans opacity-70">{cohortText(item)}</span>
              </span>
              <span className={cn('text-xs', gradeClass(item.grade))}>
                {gradeText(item.grade)}
                {item.distance > 0 ? `（错 ${item.distance}/${item.chars} 字 · ${formatCer(item.cer)}）` : ''}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <input
                className="min-w-0 flex-1 rounded border border-border/60 bg-transparent px-2 py-1 text-xs leading-relaxed"
                value={draft[item.key] ?? item.expected}
                onChange={(event) =>
                  setDraft((current) => ({ ...current, [item.key]: event.target.value }))
                }
                placeholder="稿子里那句"
              />
              <Button size="sm" variant="ghost" disabled={busy === item.key} onClick={() => play(item)}>
                重听
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={busy === item.key || (draft[item.key] ?? item.expected) === item.expected}
                onClick={() => save(item)}
              >
                保存答案
              </Button>
            </div>
            <p className={cn('text-xs leading-relaxed', gradeClass(item.grade))}>{item.actual || '（空）'}</p>
          </li>
        ))}
      </ul>

      {note ? <p className="px-4 py-2 text-xs text-muted-foreground">{note}</p> : null}

      {running && items.length === 0 ? (
        <p className="px-4 py-6 text-center text-xs text-muted-foreground">正在加载识别模型…</p>
      ) : null}
    </Modal>
  )
}
