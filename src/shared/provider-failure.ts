/**
 * 供应商失败的分类与文案（#86）。
 *
 * 之前超时、限流、key 错、模型名写错全变成同一句「翻译失败」：用户不知道是自己填错了、
 * 是服务商在限流、还是网络抖了一下——三件事的下一步动作完全不同（改 key / 等一会 / 直接重试）。
 *
 * 这里只做判断与措辞，**不发请求也不重试**：重试节奏由调用方按 `retry` / `retryAfterMs` 执行。
 */
export type ProviderFailureKind =
  | 'no-key'
  | 'auth'
  | 'rate-limit'
  | 'model-missing'
  | 'timeout'
  | 'network'
  | 'server'
  | 'bad-response'
  | 'empty'
  | 'unknown'

/** `no` = 重试也没用（改配置才有用）；`soon` = 立刻可再试；`later` = 隔一会再试。 */
export type ProviderRetry = 'no' | 'soon' | 'later'

export interface ProviderFailure {
  kind: ProviderFailureKind
  title: string
  detail: string
  hint: string
  retry: ProviderRetry
  retryAfterMs: number | null
}

export interface ProviderFailureInput {
  status?: number | null
  message: string
  timedOut?: boolean
  /** 429 的 `Retry-After`（秒或 HTTP 日期），拿不到就 null。 */
  retryAfter?: string | null
}

/** 默认的等待时长：限流要等得比 5xx 久，网络抖动几乎可以立刻重试。 */
const WAIT_MS: Record<ProviderFailureKind, number | null> = {
  'no-key': null,
  auth: null,
  'rate-limit': 5_000,
  'model-missing': null,
  timeout: 1_500,
  network: 2_000,
  server: 3_000,
  'bad-response': 1_500,
  empty: 1_500,
  unknown: 3_000
}

const RETRY_OF: Record<ProviderFailureKind, ProviderRetry> = {
  'no-key': 'no',
  auth: 'no',
  'rate-limit': 'later',
  'model-missing': 'no',
  timeout: 'soon',
  network: 'soon',
  server: 'later',
  'bad-response': 'soon',
  empty: 'soon',
  unknown: 'later'
}

/** 一句能照着做的提示：不同种类的下一步不一样，别让它们共用一句话。 */
const HINT_OF: Record<ProviderFailureKind, string> = {
  'no-key': '在「翻译引擎」页填上 API key 再试',
  auth: 'key 不对或已失效：去「翻译引擎」页重新填一次（不是网络问题，重试没用）',
  'rate-limit': '等一会再发，不用改配置',
  'model-missing': '模型名对不上：在「翻译引擎」页换一个该服务商确实有的模型',
  timeout: '网络慢或服务商拥堵，稍等再试一次',
  network: '检查代理与网络，稍等再试',
  server: '那边出错了（5xx），不是你的配置问题，隔一会再试',
  'bad-response': '返回的不是约定格式：多半是代理或网关插了一手，检查代理地址',
  empty: '模型回了空正文（推理模型常见）：调大 maxTokens 或换模型',
  unknown: '原因不明：看一眼「关于 → 诊断」里的最近错误'
}

const TITLE_OF: Record<ProviderFailureKind, string> = {
  'no-key': '还没填 API key',
  auth: 'API key 被拒绝',
  'rate-limit': '被服务商限流',
  'model-missing': '模型不存在',
  timeout: '请求超时',
  network: '连不上服务商',
  server: '服务商出错',
  'bad-response': '返回格式不对',
  empty: '模型回了空正文',
  unknown: '翻译失败'
}

/** `Retry-After` 可能是秒，也可能是 HTTP 日期；只认这两件事，认不出返回 null。 */
export function parseRetryAfter(raw: string | null | undefined, now = Date.now()): number | null {
  if (raw === null || raw === undefined) return null
  const text = raw.trim()
  if (text === '') return null
  if (/^\d+$/.test(text)) {
    const seconds = Number(text)
    return Number.isFinite(seconds) ? seconds * 1000 : null
  }
  const at = Date.parse(text)
  if (Number.isNaN(at)) return null
  return Math.max(0, at - now)
}

function classify(input: ProviderFailureInput): ProviderFailureKind {
  const message = input.message.toLowerCase()
  if (input.timedOut === true || /aborted|timeout|timed out|etimedout/.test(message)) return 'timeout'
  if (/requires an api key|no api key|api key 为空/.test(message)) return 'no-key'
  // Chromium 的网络栈报的是 `net::ERR_CONNECTION_REFUSED` 这种形状（下划线、不是 `ECONNREFUSED`），
  // Node 侧才是 `fetch failed: ECONNREFUSED`——两种都要认，否则「连不上」会被归到「原因不明」。
  if (/econnreset|econnrefused|enotfound|eai_again|fetch failed|socket hang up|net::err_|network/.test(message))
    return 'network'
  const status = input.status ?? null
  if (status === 401 || status === 403) return 'auth'
  if (status === 429) return 'rate-limit'
  if (status === 404) return 'model-missing'
  if (/model.*(not found|does not exist|unknown|不存在)/.test(message)) return 'model-missing'
  if (status !== null && status >= 500) return 'server'
  if (/不是 json|unexpected token|invalid json/.test(message)) return 'bad-response'
  if (/空正文|empty/.test(message)) return 'empty'
  if (status !== null && status >= 400) return 'unknown'
  return 'unknown'
}

/**
 * 这次失败属于哪一类、下一步该干什么。
 *
 * `detail` 保留原始消息的前 200 字：分类可能判错，别把唯一证据吃掉。
 */
export function judgeProviderFailure(input: ProviderFailureInput): ProviderFailure {
  const kind = classify(input)
  const retryAfterParsed = kind === 'rate-limit' ? parseRetryAfter(input.retryAfter) : null
  return {
    kind,
    title: TITLE_OF[kind],
    detail: input.message.slice(0, 200),
    hint: HINT_OF[kind],
    retry: RETRY_OF[kind],
    retryAfterMs: retryAfterParsed ?? WAIT_MS[kind]
  }
}

/** 面板与日志共用的一句话：标题 + 该怎么办，原始消息另起一行（复制给别人时带上它）。 */
export function failureLine(failure: ProviderFailure): string {
  return `${failure.title}：${failure.hint}`
}

/** 两类文案不许互相包含——否则「每类各有各的话」这条验收就是假的。 */
export function failuresDistinct(failures: readonly ProviderFailure[]): boolean {
  const lines = failures.map((failure) => failureLine(failure))
  return new Set(lines).size === lines.length
}
