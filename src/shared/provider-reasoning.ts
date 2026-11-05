import type { ProviderConfig, ProviderId } from './ipc'

/**
 * 每家供应商关/开「先思考」用的不是同一个字段，猜错就是 400 或者白等 7 秒：
 * - zai：小米 MiMo、智谱 GLM 同源，`thinking: { type: 'enabled' | 'disabled' }`
 * - deepseek：同一套 `thinking` 字段，但只在需要时下发
 * - openai：`reasoning_effort`（o 系列）；custom 按 OpenAI 兼容处理
 * - ollama：本地模型没有统一开关，什么都不发
 */
export type ThinkingFormat = 'zai' | 'deepseek' | 'openai'

export function thinkingFormatFor(id: ProviderId): ThinkingFormat | null {
  switch (id) {
    case 'mimo':
    case 'zhipu':
      return 'zai'
    case 'deepseek':
      return 'deepseek'
    case 'openai':
    case 'custom':
      return 'openai'
    default:
      return null
  }
}

/** 面板上的「推理」开关。没写就是关：翻译是短句任务，思考只加延迟。 */
export function reasoningEnabled(provider: Pick<ProviderConfig, 'reasoning'>): boolean {
  return provider.reasoning === true
}

/**
 * pi-ai 的思考档位。开着用 medium：够用，又不像 high 那样把一句译文拖到十几秒；
 * 关着必须是 'off'，pi-ai 才会把 reasoningEffort 置空，各家分支据此下发「关」。
 */
export function thinkingLevelFor(provider: Pick<ProviderConfig, 'reasoning'>): 'off' | 'medium' {
  return reasoningEnabled(provider) ? 'medium' : 'off'
}

/**
 * 直连对冲路径（openai-compat 自己拼 JSON，不经过 pi-ai）要补的推理字段。
 * 关推理必须写全各家的「关」方言，否则 MiMo 会先思考 7 秒才吐译文。
 */
export function directReasoningParams(provider: Pick<ProviderConfig, 'id' | 'reasoning'>): Record<string, unknown> {
  const on = reasoningEnabled(provider)
  switch (provider.id) {
    case 'mimo':
      // 实测：reasoning_effort:'none' 把同一句从 7.4s 压到 1.4s，译文不变。
      // 打开时不带 effort（MiMo 不认档位），只把 thinking 打开。
      return on ? { thinking: { type: 'enabled' } } : { reasoning_effort: 'none' }
    case 'zhipu':
      return { thinking: { type: on ? 'enabled' : 'disabled' } }
    case 'deepseek':
      // deepseek-chat 默认不思考，关的时候什么都不发最安全。
      return on ? { thinking: { type: 'enabled' } } : {}
    case 'openai':
    case 'custom':
      return on ? { reasoning_effort: 'medium' } : {}
    default:
      return {}
  }
}
