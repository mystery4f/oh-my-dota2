import * as React from 'react'
import { Button } from '@/components/ui/button'
import { Panel } from '@/panel/components/primitives'
import { cn } from '@/lib/utils'
import { ENTRIES, stepsFor, type Step } from './mock'

const RING: Record<Step['state'], string> = {
  ready: 'border-emerald-500/50 text-emerald-300',
  warn: 'border-amber-500/50 text-amber-300',
  bad: 'border-destructive/60 text-destructive'
}

/**
 * 方案 B「链路工作台」：把对讲画成一条流水线，五段各管一段，断在哪一段当场看得出来；
 * 右边是流水线的产出（说了什么、多久、播没播出去）。设置挂在各自的节点上，不做独立清单。
 */
export function VariantB({ broken }: { broken: boolean }): React.ReactElement {
  const steps = stepsFor(broken)
  const pipeline: Step[] = [
    ...steps,
    {
      key: 'game',
      name: '游戏语音',
      detail: 'CABLE Output → Dota 2 麦克风',
      state: broken ? 'warn' : 'ready'
    }
  ]

  return (
    <div className="space-y-4">
      <div className="grid grid-cols-[288px_1fr] items-start gap-3">
        <Panel className="px-4 py-3">
          <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            流水线
          </div>
          <div className="mt-3">
            {pipeline.map((step, i) => (
              <div key={step.key} className="relative flex gap-3 pb-4 last:pb-0">
                {i < pipeline.length - 1 ? (
                  <span className="absolute left-[11px] top-6 h-full w-px bg-border/70" />
                ) : null}
                <span
                  className={cn(
                    'relative z-10 flex h-6 w-6 shrink-0 items-center justify-center rounded-full border bg-card text-[11px] font-mono',
                    RING[step.state]
                  )}
                >
                  {i + 1}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
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
                  <p className="mt-0.5 text-[11px] leading-snug text-muted-foreground">
                    {step.detail}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </Panel>

        <div className="space-y-3">
          <Panel className="grid grid-cols-3 divide-x divide-border/50">
            {[
              { k: '今天', v: '17', unit: '次' },
              { k: '起播中位', v: '0.9', unit: '秒' },
              { k: '没播出去', v: '1', unit: '条' }
            ].map((stat) => (
              <div key={stat.k} className="px-3 py-2.5">
                <div className="text-[10px] text-muted-foreground">{stat.k}</div>
                <div className="mt-0.5">
                  <span className="text-[17px] font-medium tabular-nums">{stat.v}</span>
                  <span className="ml-1 text-[10px] text-muted-foreground">{stat.unit}</span>
                </div>
              </div>
            ))}
          </Panel>

          <Panel>
            <div className="px-3 py-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
              产出
            </div>
            <div className="divide-y divide-border/40 border-t border-border/60">
              {ENTRIES.map((entry) => (
                <div key={entry.at} className="px-3 py-2">
                  <div className="flex items-baseline gap-1.5">
                    <span className="truncate text-[12px]">{entry.transcript}</span>
                    <span
                      className={cn(
                        'ml-auto shrink-0 font-mono text-[10px]',
                        entry.spoken ? 'text-emerald-300/80' : 'text-amber-300/80'
                      )}
                    >
                      {entry.spoken
                        ? `起播 ${(entry.firstAudioMs / 1000).toFixed(1)}s`
                        : '没播出去'}
                    </span>
                  </div>
                  <div className="mt-0.5 flex items-baseline gap-1.5">
                    <span className="truncate text-[11px] text-muted-foreground">
                      {entry.translated}
                    </span>
                    <span className="ml-auto shrink-0 font-mono text-[10px] text-muted-foreground">
                      {(entry.totalMs / 1000).toFixed(1)}s
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </Panel>
        </div>
      </div>

      <Panel className="flex items-center gap-3 px-4 py-3">
        <Button className="h-10 flex-1">按住说话 · Alt+Shift+V</Button>
        <Button variant="outline" className="h-10">
          试一句
        </Button>
        <Button variant="outline" className="h-10">
          测试声出
        </Button>
      </Panel>

      <p className="px-1 text-[11px] text-muted-foreground">
        每个节点点开就是它自己的那一行设置（讲话设备、识别引擎、引擎与音色、虚拟声卡），
        没有单独的「设置」区——要改什么，就在断的那一段改。
      </p>
    </div>
  )
}
