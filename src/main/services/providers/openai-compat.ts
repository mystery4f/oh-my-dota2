import { net } from 'electron'
import type { ProviderConfig } from '@shared/ipc'

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
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
  const res = await net.fetch(endpoint(provider.baseUrl), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...authHeader },
    body: JSON.stringify({
      model: provider.model,
      messages,
      temperature,
      max_tokens: maxTokens,
      stream: false,
      // mimo 默认会先思考：关掉后同一句翻译从 7.4s 降到 1.4s，译文不变。
      ...(provider.id === 'mimo' ? { reasoning_effort: 'none' } : {})
    }),
    signal: AbortSignal.timeout(timeoutMs)
  })
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error('模型服务返回 HTTP ' + res.status + '（' + provider.model + '）：' + body.slice(0, 300))
  }
  const raw = await res.text()
  let data: {
    choices?: Array<{ finish_reason?: string; message?: { content?: string; reasoning_content?: string } }>
  }
  try {
    data = JSON.parse(raw) as typeof data
  } catch {
    throw new Error('模型服务返回的不是 JSON（' + provider.model + '）：' + raw.slice(0, 200))
  }
  const choice = data.choices?.[0]
  const text = choice?.message?.content?.trim()
  if (!text) {
    if (choice?.finish_reason === 'length') {
      throw new Error(
        '模型把 maxTokens 全用在思考上，没留下正文（推理模型常见）——调大 maxTokens 后重试：' +
          raw.slice(0, 160)
      )
    }
    throw new Error('模型返回了空正文（reasoning 模型或服务端抖动）：' + raw.slice(0, 200))
  }
  console.log('provider: ' + provider.model + ' replied in ' + (Date.now() - started) + 'ms')
  return text
}
