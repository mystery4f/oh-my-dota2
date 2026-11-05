import type { ProviderConfig, ProviderId, ProviderPreset } from './ipc'

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

/**
 * pi-ai 的 compat 位（#30）：方言只在这里翻译成字段名，会话层不再自己判一遍。
 * zai/deepseek 走 thinking 对象，openai 兼容走 reasoning_effort，其余什么都不发。
 */
export function thinkingCompatFor(id: ProviderId): {
  thinkingFormat?: 'zai' | 'deepseek'
  supportsReasoningEffort?: boolean
} {
  const format = thinkingFormatFor(id)
  if (format === 'zai' || format === 'deepseek') return { thinkingFormat: format }
  if (format === 'openai') return { supportsReasoningEffort: true }
  return {}
}

/**
 * 切供应商/载入时这一格该亮的开关（#43）：预设声明 > 该供应商自己的存档 > 默认关。
 * MiMo 要思考、智谱 flash 不要，切家时跟着换，不用重新点。
 */
export function reasoningForProvider(
  id: ProviderId,
  preset: ProviderPreset | undefined,
  providerReasoning: Partial<Record<ProviderId, boolean>> | undefined
): boolean {
  if (preset && 'reasoning' in preset) return preset.reasoning === true
  return providerReasoning?.[id] === true
}

/**
 * 载入归位（#43）：预设表声明了 reasoning 就以声明为真理，活值与存档一起归位——和 authStyle
 * 同一个治病模式；没声明的预设（现表里全部）与 custom 保留用户存档值，开关仍可各家各编辑。
 * 存档不是对象（手编坏了）时静默兜底成空表，不让读取炸掉。
 */
export function healProviderReasoning(
  id: ProviderId,
  reasoning: boolean | undefined,
  preset: ProviderPreset | undefined,
  providerReasoning: Partial<Record<ProviderId, boolean>> | undefined
): { reasoning: boolean | undefined; providerReasoning: Partial<Record<ProviderId, boolean>> } {
  const archive = providerReasoning && typeof providerReasoning === 'object' ? { ...providerReasoning } : {}
  if (preset && 'reasoning' in preset) {
    const declared = preset.reasoning === true
    return { reasoning: declared, providerReasoning: { ...archive, [id]: declared } }
  }
  return { reasoning, providerReasoning: archive }
}
