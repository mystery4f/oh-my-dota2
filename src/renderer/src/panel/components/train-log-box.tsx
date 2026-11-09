import * as React from 'react'
import type { TrainLogPage } from '@shared/train/task'
import { Button } from '@/components/ui/button'

/** 把日志行开头的 ISO 时间戳压成 HH:mm:ss（跨天补日期），其余内容原样保留。 */
function trimStamp(line: string): string {
  const match = /^\[(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?Z\]\s?/.exec(line)
  if (!match) return line
  const [, year, month, day, hours, minutes, seconds] = match
  const today = new Date()
  const sameDay =
    Number(year) === today.getFullYear() && Number(month) === today.getMonth() + 1 && Number(day) === today.getDate()
  return `${sameDay ? '' : `${month}-${day} `}${hours}:${minutes}:${seconds} ${line.slice(match[0].length)}`
}

/** 训练栈的报错就长这样：挂在日志里最显眼的颜色上，扫一眼能定位。 */
const ERROR_RE = /Traceback|Error:|error:|失败|CUDA out of memory|OutOfMemory/i

/**
 * 训练日志（logs/train.log 的尾巴）：训练中每 2 秒刷新一次，训练结束再补刷一次。
 *
 * 为什么读文件而不是读 IPC 广播的环形日志：环形日志只有 120 行、关掉窗口就没了，
 * 而用户要看的恰恰是「这一轮到底跑了多少条、卡在哪一步」。文件是唯一完整的那份。
 */
export function TrainLogBox({ running }: { running: boolean }): React.ReactElement {
  const [page, setPage] = React.useState<TrainLogPage | null>(null)
  const [follow, setFollow] = React.useState(true)
  const boxRef = React.useRef<HTMLPreElement | null>(null)

  const load = React.useCallback(async (): Promise<void> => {
    const next = await window.api.trainLog({ limit: 400 })
    setPage(next)
  }, [])

  React.useEffect(() => {
    void load()
    if (!running) return
    const timer = window.setInterval(() => void load(), 2000)
    return () => window.clearInterval(timer)
  }, [load, running])

  // 训练刚结束：再读一次，把换模/导出那几行收进来。
  React.useEffect(() => {
    if (!running) void load()
  }, [load, running])

  // 跟随到底部，但用户往上滚看历史时不抢滚动条。
  React.useEffect(() => {
    const box = boxRef.current
    if (!box || !follow) return
    box.scrollTop = box.scrollHeight
  }, [page, follow])

  const lines = page?.lines ?? []
  const copyPath = (): void => {
    if (page?.path) void navigator.clipboard.writeText(page.path)
  }

  return (
    <div className="py-3">
      <div className="mb-2 flex items-center justify-between gap-3">
        <div className="min-w-0">
          <div className="text-sm font-medium">训练日志</div>
          <div className="truncate text-xs text-muted-foreground" title={page?.path ?? ''}>
            {page?.path ?? '正在读日志…'}
            {page?.truncated ? '（只显示最后 400 行）' : ''}
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <Button size="sm" variant="ghost" onClick={copyPath}>
            复制路径
          </Button>
          <Button size="sm" variant="ghost" onClick={() => void load()}>
            刷新
          </Button>
        </div>
      </div>
      <pre
        ref={boxRef}
        onScroll={(event) => {
          const box = event.currentTarget
          setFollow(box.scrollHeight - box.scrollTop - box.clientHeight < 24)
        }}
        className="max-h-72 overflow-auto rounded border border-border/60 bg-muted/30 p-2 font-mono text-[11px] leading-relaxed whitespace-pre-wrap break-all"
      >
        {lines.length === 0 ? (
          <span className="text-muted-foreground">还没有日志：点「开始训练」后，这里会从第一条录音开始写。</span>
        ) : (
          lines.map((line, index) => (
            <div key={`${index}-${line.slice(0, 24)}`} className={ERROR_RE.test(line) ? 'text-amber-600 dark:text-amber-400' : ''}>
              {trimStamp(line)}
            </div>
          ))
        )}
      </pre>
    </div>
  )
}
