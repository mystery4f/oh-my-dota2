/**
 * #71 量测探针：子句流水（首句先出声）vs 整句（等整句翻完再念）。
 *
 * 为什么是探针而不是脚本：翻译走 `chatCompletion`，它用 Electron 的 `net`（跟着系统代理走），
 * 纯 Node 里没有这套；所以量测只能在 Electron 里跑，与产品同一条代码路径。
 *
 * **不进 CI**：要真调模型和真合成，慢、要网、要花钱。
 *
 * 两个臂都从 t0 开始计时，t0 = 这一句开始翻译：
 * - 整句：翻译整句 → 合成整句 → firstAudioMs = 合成完成；
 * - 子句：翻第一句 → 立刻合成第一句 → firstAudioMs = 第一句合成完成，之后按原顺序把余下子句
 *   翻完念完，totalMs = 最后一句合成完成。
 *
 * 参数只走环境变量，绝不写进 settings：`BENCH_BASE_URL`（默认 http://127.0.0.1:3425/v1）、
 * `BENCH_MODEL`（默认 group/deepseek-flash）、`BENCH_KEY`（默认 not-needed）、
 * `BENCH_LINES`（取多少条，默认 30）、`BENCH_PROGRESS`（写了就往该文件追加进度，便于看卡在哪）。
 */
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { splitClauses } from '@shared/clause-plan'
import { DEFAULT_VOICE_OUT_VOICE, VOICE_OUT_VOICES } from '@shared/voice-out'
import type { ProviderConfig } from '@shared/providers'
import { buildSystemPrompt } from '../services/providers/index'
import { chatCompletion } from '../services/providers/openai-compat'
import { synthesizeEdge } from '../services/voice/edge'
import { finishProbe, probeCases } from './harness'

const VOICE = DEFAULT_VOICE_OUT_VOICE

/** 进度只写文件：探针 stdout 在重定向时是块缓冲，被 kill 就一行都看不到。 */
function prog(step: string, extra: Record<string, unknown> = {}): void {
  const path = process.env.BENCH_PROGRESS
  if (path === undefined || path === '') return
  try {
    appendFileSync(path, JSON.stringify({ at: Date.now(), step, ...extra }) + '\n')
  } catch {
    // 进度写失败不影响量测
  }
}

function benchProvider(): ProviderConfig {
  return {
    id: 'openai-compat' as ProviderConfig['id'],
    baseUrl: process.env.BENCH_BASE_URL ?? 'http://127.0.0.1:3425/v1',
    apiKey: process.env.BENCH_KEY ?? 'not-needed',
    model: process.env.BENCH_MODEL ?? 'group/deepseek-flash'
  }
}

/**
 * 源句：录音脚本里的句子（用户真正会说的那些话），按字数取最长的几条。
 * 开发态下 `app.getAppPath()` 是 `<repo>/out/main`，所以随包资源按仓库根找；数据目录里的自定义稿优先。
 */
function sourceLines(count: number): string[] {
  const candidates = [
    join(app.getPath('userData'), 'asr-ft-script.md'),
    join(process.cwd(), 'resources', 'asr-ft-script.md'),
    join(app.getAppPath(), '..', '..', 'resources', 'asr-ft-script.md')
  ]
  for (const path of candidates) {
    let markdown = ''
    try {
      markdown = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    // 只取 ## Gxx 分组里的句子：开头的说明段也含汉字，混进来就不是用户会说的话了。
    const lines: string[] = []
    let inGroup = false
    for (const raw of markdown.split(/\r?\n/)) {
      if (/^##\s/.test(raw)) {
        inGroup = /^##\s*G\d+/.test(raw)
        continue
      }
      if (!inGroup) continue
      // 脚本里的句子带 1. / 2. 这种序号，真实识别结果不会带；序号留着会被切成「9」这种假子句。
      const text = raw.replace(/^[-*]\s*/, '').replace(/^\d+\.\s*/, '').trim()
      if (hanShareOf(text) >= 0.5 && text.length >= 8) lines.push(text)
    }
    if (lines.length > 0) return [...lines].sort((a, b) => b.length - a.length).slice(0, count)
  }
  return []
}

function hanShareOf(text: string): number {
  const han = (text.match(/[一-龥]/g) ?? []).length
  const letters = (text.match(/[A-Za-z一-龥]/g) ?? []).length
  return letters === 0 ? 0 : han / letters
}

function median(values: number[]): number {
  if (values.length === 0) return 0
  const sorted = [...values].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1 ? sorted[middle] : Math.round((sorted[middle - 1] + sorted[middle]) / 2)
}

export async function runClauseStreamBench(): Promise<void> {
  prog('enter')
  const { cases, push } = probeCases()
  const provider = benchProvider()
  const system = buildSystemPrompt('zh-en', 'terse')
  const lines = sourceLines(Number(process.env.BENCH_LINES ?? '30'))
  push('拿到足够多的源句', lines.length >= 10, `${lines.length} 条`)
  prog('lines', { count: lines.length, model: provider.model })

  const translateOnce = async (text: string): Promise<string> => {
    const out = await chatCompletion({
      provider,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: '$' + text }
      ],
      temperature: 0.2,
      // 网关上的 deepseek-flash 先写 reasoning_content：预算给小了正文回 null（实测 finish_reason=length）。
      maxTokens: 1200,
      timeoutMs: 20000
    })
    return out.trim()
  }

  /** 网关偶发空正文/超时：一次重试，仍失败才算这一句失败（臂内统计不受单次抖动左右）。 */
  const translate = async (text: string): Promise<string> => {
    try {
      return await translateOnce(text)
    } catch {
      return await translateOnce(text)
    }
  }

  const noTts = process.env.BENCH_NO_TTS === '1'
  const speak = async (text: string): Promise<void> => {
    if (noTts) return
    const audio = await synthesizeEdge(text, VOICE, 1, 1, VOICE_OUT_VOICES)
    if (audio === null || audio.length === 0) throw new Error('没有音频')
  }

  const wholeFirst: number[] = []
  const wholeTotal: number[] = []
  const clauseFirst: number[] = []
  const clauseTotal: number[] = []
  let clauseRows = 0
  const failures: string[] = []
  let index = 0

  for (const line of lines) {
    index += 1
    // —— 整句 ——
    try {
      const started = Date.now()
      prog('whole-translate', { index })
      const en = await translate(line)
      prog('whole-speak', { index, en })
      await speak(en)
      const ms = Date.now() - started
      wholeFirst.push(ms)
      wholeTotal.push(ms)
      prog('whole-ok', { index, ms })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`whole:${message}`)
      prog('whole-fail', { index, error: message })
    }

    // —— 子句流水 ——
    const clauses = splitClauses(line)
    if (clauses.length < 2) continue
    clauseRows += 1
    try {
      const started = Date.now()
      const pending = clauses.map((clause) => translate(clause))
      const firstEn = await pending[0]
      prog('clause-speak', { index, firstEn })
      await speak(firstEn)
      const first = Date.now() - started
      for (let rest = 1; rest < pending.length; rest += 1) {
        const en = await pending[rest]
        await speak(en)
      }
      clauseFirst.push(first)
      clauseTotal.push(Date.now() - started)
      prog('clause-ok', { index, first, clauses: clauses.length })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`clause:${message}`)
      prog('clause-fail', { index, error: message })
    }
  }

  const payload = {
    baseUrl: provider.baseUrl,
    model: provider.model,
    lines: lines.length,
    clauseRows,
    whole: { first: median(wholeFirst), total: median(wholeTotal), samples: wholeFirst.length },
    clause: { first: median(clauseFirst), total: median(clauseTotal), samples: clauseFirst.length },
    deltaFirstMs: median(clauseFirst) - median(wholeFirst),
    deltaTotalMs: median(clauseTotal) - median(wholeTotal),
    failures: failures.slice(0, 5)
  }
  console.log('CLAUSE_STREAM_BENCH ' + JSON.stringify(payload))
  prog('done', payload)

  push('整句臂有样本', wholeFirst.length > 0, String(wholeFirst.length))
  push('子句臂有样本', clauseFirst.length > 0, String(clauseFirst.length))
  // 单子句的句子本来就切不开（也谈不上流水），两臂样本数天然不等；这里只保证子句臂有足够样本。
  push('子句臂样本足够（能切开的句子）', clauseRows >= 5, `${clauseRows} 句可切 / ${lines.length} 句`)
  push('整句臂覆盖全部样本', wholeFirst.length >= lines.length - 2, `${wholeFirst.length}/${lines.length}`)
  push('量测打出了两组中位数', true, `首句差 ${payload.deltaFirstMs} ms · 整条差 ${payload.deltaTotalMs} ms`)

  finishProbe('CLAUSE_STREAM_BENCH', cases)
}
