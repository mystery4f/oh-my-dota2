/**
 * #86：供应商失败矩阵的纯判据 + 真实抛错路径。
 *
 * 这里不打任何真 API：分类逻辑全部离线，唯一经过网络栈的断言是「`chatCompletion` 抛出的
 * 错误带分类」——用一条必然失败的配置（不存在的 baseUrl）触发，不花钱也不依赖网络。
 */
import {
  failuresDistinct,
  failureLine,
  judgeProviderFailure,
  parseRetryAfter
} from '@shared/provider-failure'
import { finishProbe, probeCases } from './harness'

export async function runProviderFailureProbe(): Promise<void> {
  const { cases, push } = probeCases()

  const noKey = judgeProviderFailure({ message: 'provider "deepseek" requires an API key' })
  push('没填 key：单独一类，重试没用', noKey.kind === 'no-key' && noKey.retry === 'no', noKey.kind)

  const auth = judgeProviderFailure({ status: 401, message: '模型服务返回 HTTP 401：Invalid API key' })
  push('401 = key 被拒，重试没用', auth.kind === 'auth' && auth.retry === 'no', auth.kind)

  const forbidden = judgeProviderFailure({ status: 403, message: 'HTTP 403' })
  push('403 也算鉴权失败（不是「服务商出错」）', forbidden.kind === 'auth', forbidden.kind)

  const limited = judgeProviderFailure({
    status: 429,
    message: '模型服务返回 HTTP 429：rate limited',
    retryAfter: '7'
  })
  push('429 = 限流，按 Retry-After 等 7 秒', limited.kind === 'rate-limit' && limited.retryAfterMs === 7_000, String(limited.retryAfterMs))

  const limitedNoHeader = judgeProviderFailure({ status: 429, message: 'HTTP 429' })
  push('429 没有 Retry-After 时用默认 5 秒', limitedNoHeader.retryAfterMs === 5_000, String(limitedNoHeader.retryAfterMs))

  const missing = judgeProviderFailure({ status: 404, message: 'HTTP 404' })
  push('404 = 模型名不存在，重试没用', missing.kind === 'model-missing' && missing.retry === 'no', missing.kind)

  const missingByBody = judgeProviderFailure({
    status: 400,
    message: 'HTTP 400：The model `xx` does not exist'
  })
  push('400 但正文说模型不存在：按模型名错处理', missingByBody.kind === 'model-missing', missingByBody.kind)

  const server = judgeProviderFailure({ status: 503, message: 'HTTP 503 Service Unavailable' })
  push('5xx = 服务商的问题，隔一会再试', server.kind === 'server' && server.retry === 'later', server.kind)

  const timeout = judgeProviderFailure({ message: 'The operation was aborted', timedOut: true })
  push('超时：可以立刻再试', timeout.kind === 'timeout' && timeout.retry === 'soon', timeout.kind)

  const network = judgeProviderFailure({ message: 'fetch failed: ECONNRESET' })
  push('断网/代理断：可以立刻再试', network.kind === 'network' && network.retry === 'soon', network.kind)

  const badJson = judgeProviderFailure({ message: '模型服务返回的不是 JSON（x）：<html>' })
  push('非 JSON：多半是网关插了一手', badJson.kind === 'bad-response', badJson.kind)

  const empty = judgeProviderFailure({ message: '模型返回了空正文（reasoning 模型或服务端抖动）' })
  push('空正文：单独一类', empty.kind === 'empty', empty.kind)

  const all = [noKey, auth, limited, missing, server, timeout, network, badJson, empty]
  push('每一类各有各的一句话（互不重复）', failuresDistinct(all), String(new Set(all.map(failureLine)).size))
  push(
    '提示里能照着做（不是「翻译失败」一句话）',
    all.every((failure) => failureLine(failure).length > 8 && !failureLine(failure).startsWith('翻译失败：')),
    failureLine(auth)
  )
  push(
    '原文证据保留下来（截到 200 字）',
    judgeProviderFailure({ message: 'x'.repeat(500) }).detail.length === 200,
    String(judgeProviderFailure({ message: 'x'.repeat(500) }).detail.length)
  )

  const httpDate = parseRetryAfter(new Date(Date.now() + 30_000).toUTCString())
  push('Retry-After 是 HTTP 日期也能认', httpDate !== null && httpDate > 20_000 && httpDate <= 30_000, String(httpDate))
  push('认不出的 Retry-After 返回 null', parseRetryAfter('soon-ish') === null && parseRetryAfter('') === null)

  // 真实抛错路径：不存在的地址必然连不上，走的是 fetch 那一层的失败分类。
  const { ProviderRequestError, chatCompletion } = await import('../services/providers/openai-compat')
  let caught: unknown = null
  try {
    await chatCompletion({
      provider: {
        id: 'deepseek',
        baseUrl: 'http://127.0.0.1:9/probe',
        apiKey: 'probe-key',
        model: 'probe-model'
      },
      messages: [{ role: 'user', content: 'ping' }],
      timeoutMs: 3_000
    })
  } catch (err) {
    caught = err
  }
  push(
    '网络失败在 fetch 那一层就被分类（不是上层猜）',
    caught instanceof ProviderRequestError && caught.failure.kind === 'network',
    caught instanceof ProviderRequestError ? caught.failure.kind : String(caught)
  )
  push(
    '抛出的那句话就是 failureLine（面板与日志同一句）',
    caught instanceof ProviderRequestError && caught.message === failureLine(caught.failure),
    caught instanceof Error ? caught.message.slice(0, 40) : ''
  )

  finishProbe('PROVIDER_FAILURE_PROBE', cases)
}
