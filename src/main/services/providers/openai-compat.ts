import { net } from 'electron'
import type { ProviderConfig } from '@shared/ipc'
import { directReasoningParams } from '@shared/provider-reasoning'
import { failureLine, judgeProviderFailure, type ProviderFailure } from '@shared/provider-failure'
import { errorMessage } from '@shared/errors'
import { recordProviderCall } from './metrics'

/**
 * 带分类的请求失败（#86）：`failure` 里放着「哪一类 + 下一步干什么」。
 * 调用方（面板、浮层、日志）一律读 `failure.line`，不要各自再拼一句话——同一件事三个说法
 * 就是用户最常抱怨的「到底谁的问题」。
 */
export class ProviderRequestError extends Error {
  readonly failure: ProviderFailure

  constructor(failure: ProviderFailure) {
    super(failureLine(failure))
    this.name = 'ProviderRequestError'
    this.failure = failure
  }
}

/**
 * 一条消息的内容：纯文本，或按顺序排的几块（#135 的看图就是「文字 + 一张图」两块）。
 * 图片用 data URL 内联，绝不引用磁盘路径——模型侧只认 data URL，磁盘路径还会把本机路径发出去。
 */
export type ChatContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string | ChatContentPart[]
}

export interface ChatOptions {
  provider: ProviderConfig
  messages: ChatMessage[]
  temperature?: number
  maxTokens?: number
  timeoutMs?: number
}

function endpoint(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, '') + '/chat/completions'
}

/** Minimal OpenAI-compatible chat completion via Electron net (honors session proxy). */
export async function chatCompletion(opts: ChatOptions): Promise<string> {
  // 看板记账（#114）：成功与失败各记一行，失败带上 #86 的分类。记账失败不影响这次调用。
  const started = Date.now()
  try {
    const text = await chatCompletionInner(opts)
    recordProviderCall({
      providerId: opts.provider.id,
      model: opts.provider.model,
      ok: true,
      ms: Date.now() - started
    })
    return text
  } catch (err) {
    const failure = err instanceof ProviderRequestError ? err.failure : null
    recordProviderCall({
      providerId: opts.provider.id,
      model: opts.provider.model,
      ok: false,
      ms: Date.now() - started,
      kind: failure === null ? judgeProviderFailure({ message: errorMessage(err) }).kind : failure.kind
    })
    throw err
  }
}

async function chatCompletionInner(opts: ChatOptions): Promise<string> {
  const { provider, messages, temperature = 0.3, maxTokens = 512, timeoutMs = 30_000 } = opts
  if (!provider.apiKey && provider.id !== 'ollama') {
    throw new Error('provider "' + provider.id + '" requires an API key')
  }
  const started = Date.now()
  let authHeader: Record<string, string> = {}
  if (provider.apiKey) {
    authHeader =
      provider.authStyle === 'api-key' ? { 'api-key': provider.apiKey } : { Authorization: 'Bearer ' + provider.apiKey }
  }
  const request = net.fetch(endpoint(provider.baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader },
    body: JSON.stringify({
      model: provider.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
      // 各家「先思考」的开关不是一个字段（zai 的 thinking、OpenAI 的 reasoning_effort），
      // 由共享纯函数按 provider 决定发什么；面板的「推理」开关就是它的输入。
      ...directReasoningParams(provider)
    }),
    signal: AbortSignal.timeout(timeoutMs)
  })
  // 超时/断网在 fetch 这一层就抛（DOMException），分类要在抛出之前就定下来：
  // 到了上层只剩一句「aborted」，分不出是超时还是被取消。
  let res: Response
  try {
    res = await request
  } catch (err) {
    const raw = err instanceof Error ? err.message : String(err)
    throw new ProviderRequestError(
      judgeProviderFailure({
        message: raw,
        timedOut: err instanceof DOMException || /abort/i.test(raw)
      })
    )
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new ProviderRequestError(
      judgeProviderFailure({
        status: res.status,
        message: '模型服务返回 HTTP ' + res.status + '（' + provider.model + '）：' + body.slice(0, 300),
        retryAfter: res.headers.get('retry-after')
      })
    )
  }
  const raw = await res.text()
  let data: {
    choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning_content?: string } }>
  }
  try {
    data = JSON.parse(raw) as typeof data
  } catch {
    throw new ProviderRequestError(
      judgeProviderFailure({ message: '模型服务返回的不是 JSON（' + provider.model + '）：' + raw.slice(0, 200) })
    )
  }
  const choice = data.choices?.[0]
  const text = choice?.message?.content?.trim()
  if (!text) {
    if (choice?.finish_reason === 'length') {
      throw new ProviderRequestError(
        judgeProviderFailure({
          message:
            '模型把 maxTokens 全用在思考上，没留下正文（推理模型常见）——调大 maxTokens 后重试：' +
            raw.slice(0, 160)
        })
      )
    }
    throw new ProviderRequestError(
      judgeProviderFailure({ message: '模型返回了空正文（reasoning 模型或服务端抖动）：' + raw.slice(0, 200) })
    )
  }
  console.log('provider: ' + provider.model + ' replied in ' + (Date.now() - started) + 'ms')
  return text
}
