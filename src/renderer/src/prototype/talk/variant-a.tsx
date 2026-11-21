import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Panel } from '@/panel/components/primitives'
import { cn } from '@/lib/utils'
import { CANDIDATES, ENTRIES, HOTWORD_COUNT, HOTWORD_LIMIT, stepsFor, type Step } from './mock'

const DOT: Record<Step['state'], string> = {
  ready: 'bg-emerald-400',
  warn: 'bg-amber-400',
  bad: 'bg-destructive'
}

/**
 * 方案 A「体检台」：先回答「现在能不能说」，再给一个动作，记录在下面，设置全部收进抽屉。
 * 信息层级 = 状态 → 动作 → 证据 → 配置。
 */
export function VariantA({ broken }: { broken: boolean }): React.ReactElement {
  const steps = stepsFor(broken)
  const bad = steps.filter((s) => s.state === 'bad')
  const ok = bad.length === 0

  return (
    <div className="space-y-4">
      <Panel className="p-5">
        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <h2
              className={cn(
                'text-[19px] font-medium tracking-tight',
                ok ? 'text-foreground' : 'text-destructive'
              )}
            >
              {ok ? '现在可以说话' : `还差 ${bad.length} 步：${bad.map((s) => s.name).join('、')}`}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              {ok
                ? '按住 Alt+Shift+V 说中文，队友在游戏语音里听到英文，松开就发。'
                : `${bad[0]?.detail ?? ''}——修好这一步，前面的都不用动。`}
            </p>
          </div>
          <div className="shrink-0 rounded-md border border-border/70 px-3 py-1.5 text-center">
            <div className="font-mono text-[13px]">Alt+Shift+V</div>
            <div className="mt-0.5 text-[10px] text-muted-foreground">按住说话</div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2">
          {steps.map((step) => (
            <div
              key={step.key}
              className={cn(
                'rounded-md border px-3 py-2',
                step.state === 'bad' ? 'border-destructive/50 bg-destructive/5' : 'border-border/60'
              )}
            >
              <div className="flex items-center gap-2">
                <span className={cn('h-1.5 w-1.5 rounded-full', DOT[step.state])} />
                <span className="text-sm">{step.name}</span>
                {step.fix ? (
                  <button
                    type="button"
                    className="ml-auto text-[11px] text-primary hover:underline"
                  >
                    {step.fix}
                  </button>
                ) : null}
              </div>
              <p className="mt-1 truncate text-[11px] text-muted-foreground" title={step.detail}>
                {step.detail}
              </p>
            </div>
          ))}
        </div>
      </Panel>

      <Panel className="p-4">
        <div className="flex items-center gap-2">
          <Button className="h-10 flex-1">按住说话</Button>
          <Button variant="outline" className="h-10">
            试一句
          </Button>
          <Button variant="outline" className="h-10">
            测试声出
          </Button>
        </div>
        <p className="mt-2 text-[11px] text-muted-foreground">
          试一句 = 识别 → 翻译 → 声出全程照跑；测试声出只放音频、不按说话键。
        </p>
      </Panel>

      <Panel>
        <div className="flex items-center justify-between px-4 py-2.5">
          <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            刚刚说过的
          </span>
          <span className="text-[11px] text-muted-foreground">3 / 今天 17 条</span>
        </div>
        <div className="divide-y divide-border/40 border-t border-border/60">
          {ENTRIES.map((entry) => (
            <div key={entry.at} className="px-4 py-2.5">
              <div className="flex items-baseline gap-2">
                <span className="font-mono text-[11px] text-muted-foreground">{entry.at}</span>
                <span className="text-sm">{entry.transcript}</span>
                <span className="ml-auto font-mono text-[11px] text-muted-foreground">
                  {entry.totalMs} ms
                </span>
              </div>
              <div className="mt-0.5 flex items-baseline gap-2">
                <span className="text-xs text-muted-foreground">→</span>
                <span className="text-xs text-muted-foreground">{entry.translated}</span>
                <span
                  className={cn(
                    'ml-auto text-[11px]',
                    entry.spoken ? 'text-emerald-300/80' : 'text-amber-300/80'
                  )}
                >
                  {entry.spoken ? '已播' : '没播出去'}
                </span>
              </div>
            </div>
          ))}
        </div>
      </Panel>

      <Panel>
        <div className="flex items-start justify-between gap-4 px-4 py-3">
          <div>
            <div className="text-sm">设置</div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              讲话设备、识别引擎、热词（{HOTWORD_COUNT}/{HOTWORD_LIMIT}
              ，还有 {CANDIDATES.length} 个候选）、声出、虚拟声卡——平时用不到，坏了才进来。
            </p>
          </div>
          <Button variant="outline" size="sm" className="shrink-0">
            打开设置
          </Button>
        </div>
      </Panel>
    </div>
  )
}
