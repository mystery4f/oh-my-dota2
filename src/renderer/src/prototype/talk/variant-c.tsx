import * as React from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { CANDIDATES, ENTRIES, HOTWORD_COUNT, HOTWORD_LIMIT, stepsFor, type Step } from './mock'

const DOT: Record<Step['state'], string> = {
  ready: 'bg-emerald-400',
  warn: 'bg-amber-400',
  bad: 'bg-destructive'
}

/**
 * 方案 C「对话现场」：整页就是这一局说过的话，最新在上；链路状态压成一条细带，
 * 唯一的操作按钮钉在底部。设置收进右上角齿轮——默认一个设置项都不露。
 */
export function VariantC({ broken }: { broken: boolean }): React.ReactElement {
  const steps = stepsFor(broken)
  const bad = steps.filter((s) => s.state === 'bad')

  return (
    <div className="flex min-h-[calc(100vh-140px)] flex-col">
      <div className="flex items-center gap-2 rounded-md border border-border/60 bg-card/60 px-3 py-1.5">
        <div className="flex items-center gap-1">
          {steps.map((step) => (
            <span
              key={step.key}
              className={cn('h-1.5 w-1.5 rounded-full', DOT[step.state])}
              title={step.detail}
            />
          ))}
        </div>
        <span className="truncate text-[11px] text-muted-foreground">
          {bad.length === 0
            ? '链路正常 · Qwen3 识别 · Edge Jenny · CABLE 已接'
            : `${bad.length} 段断了：${bad.map((s) => s.name).join('、')}`}
        </span>
        <button
          type="button"
          className="ml-auto shrink-0 rounded border border-border/70 px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
          title="设置"
        >
          设置
        </button>
      </div>

      <div className="mt-5 flex-1 space-y-6">
        {ENTRIES.map((entry, i) => (
          <div key={entry.at}>
            <div className="flex items-baseline gap-2">
              <span className="text-[15px] leading-snug">{entry.transcript}</span>
              <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                {entry.at}
              </span>
            </div>
            <div className="mt-1 flex items-baseline gap-2 pl-3">
              <span className="text-[13px] leading-snug text-muted-foreground">
                {entry.translated}
              </span>
              {entry.spoken ? (
                <span className="ml-auto shrink-0 text-[10px] text-emerald-300/70">
                  起播 {(entry.firstAudioMs / 1000).toFixed(1)}s
                </span>
              ) : (
                <button
                  type="button"
                  className="ml-auto shrink-0 text-[10px] text-amber-300/80 hover:underline"
                  title="这一条没播出去：重放一次"
                >
                  没播出去 · 重放
                </button>
              )}
            </div>
            {i === 0 ? (
              <div className="mt-2 flex gap-2 pl-3">
                <button
                  type="button"
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                >
                  改字重播
                </button>
                <button
                  type="button"
                  className="text-[10px] text-muted-foreground hover:text-foreground"
                >
                  复制
                </button>
              </div>
            ) : null}
          </div>
        ))}

        <div className="border-t border-border/50 pt-3">
          <div className="flex items-baseline gap-2">
            <span className="text-[11px] text-muted-foreground">
              热词 {HOTWORD_COUNT}/{HOTWORD_LIMIT}，攒了 {CANDIDATES.length} 个候选
            </span>
            <button type="button" className="ml-auto text-[11px] text-primary hover:underline">
              顺手清一下
            </button>
          </div>
          <div className="mt-2 flex items-baseline gap-2 rounded-md border border-border/50 bg-card/40 px-2.5 py-1.5">
            <span className="text-[11px] text-muted-foreground">纠错候选 · 3 次纠错</span>
            <span className="text-[11px]">
              把你改对的句子留成训练数据（默认开，不改任何现有行为）
            </span>
            <button
              type="button"
              className="ml-auto shrink-0 text-[11px] text-primary hover:underline"
            >
              看这 3 条
            </button>
          </div>
        </div>
      </div>

      <div className="sticky bottom-0 mt-6 -mx-6 border-t border-border/60 bg-background/95 px-6 py-3 backdrop-blur">
        <div className="flex items-center gap-2">
          <Button className="h-11 flex-1 text-[15px]">按住说话</Button>
          <Button variant="outline" className="h-11">
            试一句
          </Button>
        </div>
        <p className="mt-1.5 text-center text-[10px] text-muted-foreground">
          Alt+Shift+V · 按住说中文，松开自动发英文
        </p>
      </div>
    </div>
  )
}
