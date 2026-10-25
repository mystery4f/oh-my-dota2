import { app } from 'electron'
import { getInPlaceSender } from '../services/input/chat-inplace'
import { sessionStatus, translateReply, translateTry, warmTranslator } from '../services/session/durable-translator'
import { loadSettings } from '../services/settings'

const PING_ROUNDS = 4
const DRAFTS = ['中路插个眼，小心他们开雾', '我去打野，你们守一下', '他们买活了，别追太深', '肉山还有三十秒']

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

/** 常驻输入桥的启动与往返成本：确认 600ms 的 spawn + Add-Type 已经不在热路径上。 */
export async function runInPlaceProbe(): Promise<void> {
  const bridge = getInPlaceSender()
  const cold = await bridge.ping()
  const warm: number[] = []
  for (let index = 0; index < PING_ROUNDS; index += 1) warm.push((await bridge.ping()).ms)
  console.log(
    'INPLACE_PROBE ' +
      JSON.stringify({ ok: cold.ok, readyMs: cold.readyMs, pingMs: warm, pingMedian: median(warm) })
  )
  bridge.dispose()
  app.exit(cold.ok ? 0 : 1)
}

/** 回复翻译的端到端耗时：会话慢时 2.5 秒的直连对冲有没有把尾部削掉。 */
export async function runReplyLatencyProbe(): Promise<void> {
  const provider = loadSettings().provider
  // 真实使用里启动就把会话与提示词缓存热起来了，探针照这个顺序量才有意义。
  await warmTranslator(provider)
  const timings: number[] = []
  const outputs: string[] = []
  let error: string | null = null
  for (const draft of DRAFTS) {
    const startedAt = Date.now()
    try {
      outputs.push(await translateReply(provider, draft, 'terse'))
    } catch (err) {
      error = err instanceof Error ? err.message : String(err)
      outputs.push('')
    }
    timings.push(Date.now() - startedAt)
  }
  let tryMs = 0
  try {
    const startedAt = Date.now()
    await translateTry(provider, '我马上到', 'zh-en')
    tryMs = Date.now() - startedAt
  } catch {
    // 试用链路只是参考值，失败不计入结论。
  }
  const status = sessionStatus()
  console.log(
    'REPLY_LATENCY_PROBE ' +
      JSON.stringify({
        ok: error === null && outputs.every((line) => line.length > 0),
        error,
        draftMs: timings,
        medianMs: median(timings),
        maxMs: Math.max(...timings),
        outputs,
        tryMs,
        lastFallback: status.lastFallback,
        latency: status.latency
      })
  )
  app.exit(error === null ? 0 : 1)
}
