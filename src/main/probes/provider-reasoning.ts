import { app } from 'electron'
import { PROVIDER_PRESETS, type ProviderConfig, type ProviderId } from '@shared/ipc'
import { directReasoningParams, reasoningEnabled, thinkingFormatFor, thinkingLevelFor } from '@shared/provider-reasoning'

/**
 * `--provider-reasoning-probe`：面板「推理」开关纯函数缝的行为锁。
 * 只验「哪家发什么字段」和开关默认值，零网络零模型；真的开/关思考对译文的影响由真机验收
 * （docs/ACCEPTANCE.md）。方言选错的表现是 400 或「开关点了没反应」，两种都在这里挡。
 */

interface Row {
  name: string
  ok: boolean
  detail: string
}

const cases: Row[] = []

function push(name: string, ok: boolean, detail: string): void {
  cases.push({ name, ok, detail })
}

function provider(id: ProviderId, reasoning?: boolean): ProviderConfig {
  return { id, baseUrl: 'http://127.0.0.1:1', apiKey: 'k', model: 'm', reasoning }
}

export function runProviderReasoningProbe(): void {
  // —— 方言：谁走 thinking.type，谁走 reasoning_effort ——
  push('MiMo → zai（thinking.type）', thinkingFormatFor('mimo') === 'zai', String(thinkingFormatFor('mimo')))
  push('智谱 GLM → zai（同源）', thinkingFormatFor('zhipu') === 'zai', String(thinkingFormatFor('zhipu')))
  push('DeepSeek → deepseek', thinkingFormatFor('deepseek') === 'deepseek', String(thinkingFormatFor('deepseek')))
  push('OpenAI → openai（reasoning_effort）', thinkingFormatFor('openai') === 'openai', String(thinkingFormatFor('openai')))
  push('Custom 按 OpenAI 兼容处理', thinkingFormatFor('custom') === 'openai', String(thinkingFormatFor('custom')))
  push('Ollama 没有统一开关 → null', thinkingFormatFor('ollama') === null, String(thinkingFormatFor('ollama')))

  // —— 默认值：不写就是关 ——
  push('未设置 = 关', reasoningEnabled(provider('deepseek')) === false, String(reasoningEnabled(provider('deepseek'))))
  push('显式 false = 关', reasoningEnabled(provider('deepseek', false)) === false, '')
  push('显式 true = 开', reasoningEnabled(provider('deepseek', true)) === true, '')
  push('关 → thinkingLevel off', thinkingLevelFor(provider('mimo')) === 'off', thinkingLevelFor(provider('mimo')))
  push('开 → thinkingLevel medium', thinkingLevelFor(provider('mimo', true)) === 'medium', thinkingLevelFor(provider('mimo', true)))

  // —— 直连路径请求体：关要写全各家的「关」方言 ——
  const mimoOff = JSON.stringify(directReasoningParams(provider('mimo')))
  push('MiMo 关：reasoning_effort:none（实测 7.4s → 1.4s）', mimoOff === '{"reasoning_effort":"none"}', mimoOff)
  const mimoOn = JSON.stringify(directReasoningParams(provider('mimo', true)))
  push('MiMo 开：thinking enabled', mimoOn === '{"thinking":{"type":"enabled"}}', mimoOn)
  const zhipuOff = JSON.stringify(directReasoningParams(provider('zhipu')))
  push('智谱关：thinking disabled', zhipuOff === '{"thinking":{"type":"disabled"}}', zhipuOff)
  const zhipuOn = JSON.stringify(directReasoningParams(provider('zhipu', true)))
  push('智谱开：thinking enabled', zhipuOn === '{"thinking":{"type":"enabled"}}', zhipuOn)
  push('DeepSeek 关：什么都不发', JSON.stringify(directReasoningParams(provider('deepseek'))) === '{}', '')
  push(
    'DeepSeek 开：thinking enabled',
    JSON.stringify(directReasoningParams(provider('deepseek', true))) === '{"thinking":{"type":"enabled"}}',
    JSON.stringify(directReasoningParams(provider('deepseek', true)))
  )
  push('OpenAI 关：什么都不发', JSON.stringify(directReasoningParams(provider('openai'))) === '{}', '')
  push(
    'OpenAI 开：reasoning_effort medium',
    JSON.stringify(directReasoningParams(provider('openai', true))) === '{"reasoning_effort":"medium"}',
    JSON.stringify(directReasoningParams(provider('openai', true)))
  )
  push(
    'Custom 开：reasoning_effort medium',
    JSON.stringify(directReasoningParams(provider('custom', true))) === '{"reasoning_effort":"medium"}',
    JSON.stringify(directReasoningParams(provider('custom', true)))
  )
  push('Ollama 开关都不发字段', JSON.stringify(directReasoningParams(provider('ollama', true))) === '{}', '')

  // —— 预设与开关的边界：预设不带推理，切预设不会偷偷把思考打开 ——
  const withReasoning = PROVIDER_PRESETS.filter((preset) => 'reasoning' in preset)
  push('所有预设都不声明 reasoning（默认关）', withReasoning.length === 0, withReasoning.map((p) => p.id).join(','))
  push(
    '智谱预设端点与模型可直接用',
    PROVIDER_PRESETS.some(
      (preset) => preset.id === 'zhipu' && preset.baseUrl === 'https://open.bigmodel.cn/api/paas/v4' && preset.model === 'glm-4-flash-250414'
    ),
    PROVIDER_PRESETS.map((p) => p.id).join(',')
  )

  let failed = 0
  for (const item of cases) {
    if (!item.ok) failed++
    console.log(`${item.ok ? 'PASS' : 'FAIL'} | ${item.name} | ${item.detail}`)
  }
  console.log(`PROVIDER_REASONING_PROBE ${cases.length - failed}/${cases.length} PASS`)
  app.exit(failed > 0 ? 1 : 0)
}
