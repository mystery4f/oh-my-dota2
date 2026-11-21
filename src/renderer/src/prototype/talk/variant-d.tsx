import * as React from 'react'
import { cn } from '@/lib/utils'
import { stepsFor, type Step } from './mock'

type Phase = 'idle' | 'listening' | 'translating' | 'speaking'

/** 演示用：按住→松开，走完 听 / 译 / 播 三段，并把结果落到历史里。 */
const REHEARSAL = [
  { zh: '对面猴子跳刀了，小心', en: 'Their Monkey King has Blink, careful' },
  { zh: '我出个跳刀', en: "I'll go Blink first" },
  { zh: '他们在打肉山了', en: 'They are doing Roshan' }
]

const PHASE_TEXT: Record<Phase, string> = {
  idle: '按住说话',
  listening: '正在听…',
  translating: '翻译中…',
  speaking: '正在播给队友…'
}

const DOT: Record<Step['state'], string> = {
  ready: 'bg-emerald-400',
  warn: 'bg-amber-400',
  bad: 'bg-destructive'
}

/**
 * 方案 D「对讲机」：不做页面，做一台设备。
 *
 * 整个分区只剩一个可以按下去的圆环——按住说话、松手送达，中间三态在环上讲清楚；
 * 所有设置退到右上角的一扇门后，一年只进去一次。颠覆点：表单消失，剩下的是一个按键。
 */
export function VariantD({ broken }: { broken: boolean }): React.ReactElement {
  const steps = stepsFor(broken)
  const [phase, setPhase] = React.useState<Phase>('idle')
  const [seconds, setSeconds] = React.useState(0)
  const [history, setHistory] = React.useState(REHEARSAL.slice(0, 1))
  const [drawer, setDrawer] = React.useState(false)
  const cursor = React.useRef(1)

  React.useEffect(() => {
    if (phase !== 'listening') return
    const id = window.setInterval(() => setSeconds((s) => s + 0.1), 100)
    return () => window.clearInterval(id)
  }, [phase])

  const release = React.useCallback(() => {
    if (phase !== 'listening') return
    setPhase('translating')
    window.setTimeout(() => setPhase('speaking'), 900)
    window.setTimeout(() => {
      const line = REHEARSAL[cursor.current % REHEARSAL.length]
      cursor.current += 1
      setHistory((h) => [line, ...h].slice(0, 4))
      setPhase('idle')
      setSeconds(0)
    }, 2400)
  }, [phase])

  return (
    <div className="relative flex h-[620px] flex-col items-center overflow-hidden rounded-lg border border-border/50 bg-[#0b0d10]">
      <div
        className={cn(
          'pointer-events-none absolute left-1/2 top-[38%] h-[520px] w-[520px] -translate-x-1/2 -translate-y-1/2 rounded-full blur-3xl transition-all duration-700',
          phase === 'idle' && 'bg-white/[0.03]',
          phase === 'listening' && 'bg-sky-500/20',
          phase === 'translating' && 'bg-violet-500/20',
          phase === 'speaking' && 'bg-emerald-500/20'
        )}
      />

      <div className="relative z-10 flex w-full items-center gap-2 px-5 pt-4">
        <div className="flex items-center gap-1">
          {steps.map((step) => (
            <span
              key={step.key}
              className={cn('h-1 w-1 rounded-full', DOT[step.state])}
              title={step.detail}
            />
          ))}
        </div>
        <span className="text-[11px] text-muted-foreground">
          {broken ? '翻译引擎上次超时 · 说话会失败' : '一切就绪'}
        </span>
        <button
          type="button"
          onClick={() => setDrawer((d) => !d)}
          className="ml-auto rounded border border-border/60 px-2 py-0.5 text-[11px] text-muted-foreground hover:text-foreground"
        >
          设置
        </button>
      </div>

      <div className="relative z-10 mt-10 flex flex-col items-center">
        <div className="mb-6 h-5 text-[13px] text-muted-foreground">
          {phase === 'idle' ? '松开手就送出去' : PHASE_TEXT[phase]}
        </div>

        <button
          type="button"
          onPointerDown={() => phase === 'idle' && setPhase('listening')}
          onPointerUp={release}
          onPointerLeave={release}
          disabled={broken}
          className={cn(
            'relative flex h-[248px] w-[248px] items-center justify-center rounded-full border transition-all duration-300',
            'disabled:cursor-not-allowed disabled:opacity-40',
            phase === 'idle' && 'border-white/15 bg-white/[0.02] hover:border-white/30',
            phase === 'listening' && 'border-sky-400/60 bg-sky-400/[0.06]',
            phase === 'translating' && 'border-violet-400/60 bg-violet-400/[0.06]',
            phase === 'speaking' && 'border-emerald-400/60 bg-emerald-400/[0.06]'
          )}
        >
          <span
            className={cn(
              'absolute inset-3 rounded-full border transition-opacity duration-300',
              phase === 'idle' ? 'border-white/[0.06]' : 'border-white/10'
            )}
          />
          {phase === 'listening' ? (
            <div className="flex h-16 items-center gap-[5px]">
              {Array.from({ length: 11 }).map((_, i) => (
                <span
                  key={i}
                  className="w-[3px] rounded-full bg-sky-300/80"
                  style={{
                    height: `${18 + ((i * 37) % 46)}px`,
                    animation: `pulse 700ms ${i * 60}ms ease-in-out infinite alternate`
                  }}
                />
              ))}
            </div>
          ) : phase === 'translating' ? (
            <div className="bg-gradient-to-r from-violet-300 via-white to-violet-300 bg-clip-text text-center text-[15px] text-transparent">
              翻成英文…
            </div>
          ) : phase === 'speaking' ? (
            <div className="text-center text-[15px] text-emerald-200">传送中</div>
          ) : (
            <div className="text-center">
              <div className="text-[15px] font-medium">按住说话</div>
              <div className="mt-1 font-mono text-[10px] text-muted-foreground">
                Alt + Shift + V
              </div>
            </div>
          )}
        </button>

        <div className="mt-5 h-4 font-mono text-[11px] text-muted-foreground">
          {phase === 'listening' ? `${seconds.toFixed(1)}s` : ''}
        </div>
      </div>

      <div className="relative z-10 mt-auto w-full max-w-[520px] px-6 pb-6">
        {history.map((line, i) => (
          <div
            key={`${line.zh}-${i}`}
            className={cn(
              'border-t border-white/[0.06] py-2 transition-opacity',
              i === 0 ? 'opacity-100' : 'opacity-45'
            )}
          >
            <div className="text-[13px]">{line.zh}</div>
            <div className="mt-0.5 text-[11px] text-muted-foreground">{line.en}</div>
          </div>
        ))}
      </div>

      {drawer ? (
        <div className="absolute inset-0 z-20 bg-background/80 backdrop-blur-sm">
          <div className="ml-auto h-full w-[380px] border-l border-border/60 bg-card px-5 py-4">
            <div className="flex items-baseline">
              <span className="text-sm font-medium">这台对讲机的接线</span>
              <button
                type="button"
                onClick={() => setDrawer(false)}
                className="ml-auto text-[11px] text-muted-foreground hover:text-foreground"
              >
                收起
              </button>
            </div>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              平时不会打开这一页：配好一次，往后只按那个圆。
            </p>
            <div className="mt-4 space-y-3">
              {[
                ['听谁说', '麦克风阵列（Realtek）'],
                ['认成什么字', 'Qwen3-ASR · 799 MB'],
                ['翻成哪国话', 'DeepSeek'],
                ['谁来说', 'Edge · Jenny'],
                ['怎么送进游戏', 'CABLE Input']
              ].map(([k, v]) => (
                <div key={k} className="flex items-baseline gap-2 border-b border-border/40 pb-2">
                  <span className="text-[11px] text-muted-foreground">{k}</span>
                  <span className="ml-auto text-[12px]">{v}</span>
                </div>
              ))}
            </div>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                className="rounded border border-border/60 px-2.5 py-1 text-[11px]"
              >
                试一句
              </button>
              <button
                type="button"
                className="rounded border border-border/60 px-2.5 py-1 text-[11px]"
              >
                测试声出
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}
