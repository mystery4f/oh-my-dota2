import { app } from 'electron'
import { PROVIDER_PRESETS, type ProviderConfig, type ProviderId, type ProviderPreset } from '@shared/ipc'
import {
  directReasoningParams,
  healProviderReasoning,
  reasoningEnabled,
  reasoningForProvider,
  thinkingFormatFor,
  thinkingLevelFor
} from '@shared/provider-reasoning'

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

  // —— #43 预设归位：预设表声明了 reasoning 时，存档里的野值以声明为准（authStyle 同款）。 ——
  // 现表里没有预设声明 reasoning，这里用合成预设锁住「声明即真理」的缝，未来哪家要默认开思考时归位已在。
  const declaring: ProviderPreset = {
    id: 'mimo',
    label: 'MiMo',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.6-flash',
    needsKey: true,
    reasoning: true
  }
  const healed = healProviderReasoning('mimo', false, declaring, { mimo: false, zhipu: true })
  push(
    '预设声明 reasoning:true → 存档野值归位为开（活值+存档一起归位）',
    healed.reasoning === true && healed.providerReasoning.mimo === true,
    JSON.stringify(healed)
  )
  push('归位不碰别家的表项', healed.providerReasoning.zhipu === true, healed.providerReasoning.zhipu ? 'zhipu kept' : 'zhipu lost')
  const healedOff = healProviderReasoning('mimo', true, { ...declaring, reasoning: false }, { mimo: true })
  push(
    '预设声明 reasoning:false → 存档里的开也归位为关',
    healedOff.reasoning === false && healedOff.providerReasoning.mimo === false,
    JSON.stringify(healedOff)
  )

  // —— #43 用户值保留：没声明 reasoning 的预设与 custom，存档值原样保留，开关仍可各家各编辑。 ——
  const deepseekPreset = PROVIDER_PRESETS.find((preset) => preset.id === 'deepseek')
  const untouched = healProviderReasoning('deepseek', true, deepseekPreset, { deepseek: true })
  push(
    '没声明的预设保留用户存档值（deepseek 开）',
    untouched.reasoning === true && untouched.providerReasoning.deepseek === true,
    JSON.stringify(untouched)
  )
  const customKept = healProviderReasoning('custom', true, undefined, { custom: true })
  push(
    'custom 没有预设可依，存档值原样保留',
    customKept.reasoning === true && customKept.providerReasoning.custom === true,
    JSON.stringify(customKept)
  )
  const customOff = healProviderReasoning('custom', false, undefined, { custom: false })
  push(
    'custom 关着的开关也不被翻成开',
    customOff.reasoning === false && customOff.providerReasoning.custom === false,
    JSON.stringify(customOff)
  )
  const salvage = healProviderReasoning('mimo', true, undefined, undefined)
  push(
    '存档表缺失/坏掉静默兜底成空表，不炸',
    salvage.reasoning === true && Object.keys(salvage.providerReasoning).length === 0,
    JSON.stringify(salvage)
  )

  // —— #43 切家记忆：MiMo(开) → 智谱(关) → MiMo，每家回到自己的那格，不用重新点。 ——
  const archive = { mimo: true, zhipu: false }
  const presetFor = (id: ProviderId): ProviderPreset | undefined => PROVIDER_PRESETS.find((preset) => preset.id === id)
  push(
    'MiMo 自己的档是开',
    reasoningForProvider('mimo', presetFor('mimo'), archive) === true,
    JSON.stringify(archive)
  )
  push(
    '切到智谱：回到智谱自己的档（关，不是 MiMo 的开）',
    reasoningForProvider('zhipu', presetFor('zhipu'), archive) === false,
    JSON.stringify(archive)
  )
  push(
    '切回 MiMo：还是开（每家各记各的）',
    reasoningForProvider('mimo', presetFor('mimo'), archive) === true,
    JSON.stringify(archive)
  )
  push(
    '没记过也没声明的家默认关',
    reasoningForProvider('ollama', presetFor('ollama'), archive) === false,
    'ollama 无存档'
  )
  push(
    '预设声明了就压过存档（声明即真理）',
    reasoningForProvider('mimo', declaring, { mimo: false }) === true,
    'declaring.reasoning=true, archive.mimo=false'
  )

  let failed = 0
  for (const item of cases) {
    if (!item.ok) failed++
    console.log(`${item.ok ? 'PASS' : 'FAIL'} | ${item.name} | ${item.detail}`)
  }
  console.log(`PROVIDER_REASONING_PROBE ${cases.length - failed}/${cases.length} PASS`)
  app.exit(failed > 0 ? 1 : 0)
}
