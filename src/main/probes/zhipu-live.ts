import { app } from 'electron'
import { PROVIDER_PRESETS, type ProviderConfig, type TranslateDirection } from '@shared/ipc'
import { looksLikeCommentary, replyWithinLimits } from '../services/providers'
import { sessionStatus, translateLine, translateReply, warmTranslator } from '../services/session/durable-translator'

/**
 * `--zhipu-live-probe`：用项目自己那套封装（会话链路 + 记账本 + 系统提示词）真打智谱端点，
 * 验 GLM-4-Flash-250414 的译文质量与耗时，并顺带量「推理」开关的代价。
 *
 * key 只从环境变量 `ZHIPU_API_KEY` 读：不落盘、不进设置文件、日志里只出现长度。
 * 没有 key → 直接 SKIP（退出码 0），CI 与别人的机器都不会因为缺凭据变红。
 */

const MODEL = 'glm-4-flash-250414'
const CHAT_LINES: Array<[string, TranslateDirection]> = [
  ['小心他们打肉山，他们要抢盾', 'zh-en'],
  ['他们辅助一直来中路，能不能来帮一把', 'zh-en'],
  ['大招交了，等我十秒再开', 'zh-en'],
  ['push top now, they are out of position', 'en-zh'],
  ['wait for me, i need one more item', 'en-zh']
]
const REPLY_DRAFTS = ['稳住，我们能赢，先不要送', '我先撤，你别追']

interface Row {
  name: string
  ok: boolean
  detail: string
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((left, right) => left - right)
  return sorted[Math.floor(sorted.length / 2)]
}

/** 只给长度，不露任何字符：日志会被贴进 issue 里。 */
function maskKey(key: string): string {
  const parts = key.split('.')
  if (parts.length !== 2) return `长度 ${key.length}`
  return `id ${parts[0].length} 位 + secret ${parts[1].length} 位`
}

function hasCjk(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text)
}

export async function runZhipuLiveProbe(): Promise<void> {
  const key = (process.env.ZHIPU_API_KEY ?? '').trim()
  if (key.length === 0) {
    console.log('ZHIPU_LIVE_PROBE SKIP | 没有设置环境变量 ZHIPU_API_KEY')
    app.exit(0)
    return
  }

  const preset = PROVIDER_PRESETS.find((item) => item.id === 'zhipu')
  const baseUrl = (preset?.baseUrl ?? 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '').replace(/\/chat\/completions$/, '')
  const provider: ProviderConfig = { id: 'zhipu', baseUrl, model: MODEL, apiKey: key, reasoning: false }
  console.log(`ZHIPU_LIVE_PROBE key=${maskKey(key)} model=${MODEL} baseUrl=${baseUrl}`)

  const rows: Row[] = []
  const outputs: string[] = []
  const timings: number[] = []
  let failure: string | null = null

  // 真实使用里启动就会话预热；探针照同一顺序量，首句才不是冷启动。
  const warmStartedAt = Date.now()
  await warmTranslator(provider)
  const warmMs = Date.now() - warmStartedAt

  for (const [line, direction] of CHAT_LINES) {
    const startedAt = Date.now()
    try {
      const out = await translateLine(provider, line, direction, 'terse', 'prod', 'probe')
      timings.push(Date.now() - startedAt)
      outputs.push(out)
      rows.push({
        name: `聊天 ${direction}：${line}`,
        ok: out.length > 0 && (direction === 'zh-en' ? !hasCjk(out) : hasCjk(out)),
        detail: `${out} (${timings[timings.length - 1]}ms)`
      })
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err)
      rows.push({ name: `聊天 ${direction}：${line}`, ok: false, detail: failure })
    }
  }

  for (const draft of REPLY_DRAFTS) {
    const startedAt = Date.now()
    try {
      const out = await translateReply(provider, draft, 'terse')
      rows.push({
        name: `回复 ${draft}`,
        ok: out.length > 0 && !hasCjk(out) && !looksLikeCommentary(out) && replyWithinLimits(out),
        detail: `${out} (${Date.now() - startedAt}ms)`
      })
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err)
      rows.push({ name: `回复 ${draft}`, ok: false, detail: failure })
    }
  }

  // 推理开关的代价：同一句、同一个模型，只把 provider.reasoning 打开。
  const reasoningStartedAt = Date.now()
  let reasoningMs = -1
  let reasoningOut = ''
  try {
    const thinkingProvider: ProviderConfig = { ...provider, reasoning: true }
    await warmTranslator(thinkingProvider)
    reasoningOut = await translateLine(thinkingProvider, CHAT_LINES[0][0], 'zh-en', 'terse', 'prod', 'probe')
    reasoningMs = Date.now() - reasoningStartedAt
  } catch (err) {
    rows.push({ name: '推理开：同一句', ok: false, detail: err instanceof Error ? err.message : String(err) })
  }

  let failed = 0
  for (const row of rows) {
    if (!row.ok) failed++
    console.log(`${row.ok ? 'PASS' : 'FAIL'} | ${row.name} | ${row.detail}`)
  }
  const status = sessionStatus()
  console.log(`推理开：同一句耗时 ${reasoningMs}ms，译文 ${reasoningOut || '(失败)'}`)
  console.log(
    'ZHIPU_LIVE_PROBE ' +
      JSON.stringify({
        ok: failed === 0 && failure === null,
        failed,
        cases: rows.length,
        warmMs,
        medianMs: median(timings),
        maxMs: timings.length === 0 ? 0 : Math.max(...timings),
        reasoningMs,
        outputs,
        lastFallback: status.lastFallback,
        latency: status.latency
      })
  )
  app.exit(failed === 0 && failure === null ? 0 : 1)
}
