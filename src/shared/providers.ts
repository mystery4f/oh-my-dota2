/**
 * 供应商域：id / 配置 / 预设表 / 载入仲裁。
 * 从 ipc.ts 迁出（架构扫描 C2）：改一个供应商的字段不该同时动契约、归一化和预设三处。
 * 这里刻意不 import electron / fs —— 面板、主进程和探针共用同一套预设事实。
 */
import { healProviderReasoning } from './provider-reasoning'
import type { AppSettings } from './settings-shape'

export type ProviderId = 'deepseek' | 'openai' | 'ollama' | 'mimo' | 'zhipu' | 'ark' | 'custom'

export interface ProviderConfig {
  id: ProviderId
  baseUrl: string
  apiKey: string
  model: string
  /** Auth header style; omitted means the usual "Authorization: Bearer". */
  authStyle?: 'bearer' | 'api-key'
  /** 让模型先思考（推理）再回答；默认关：翻译是短句任务，思考只加延迟。 */
  reasoning?: boolean
}

export interface ProviderPreset {
  id: ProviderId
  label: string
  baseUrl: string
  model: string
  needsKey: boolean
  authStyle?: 'bearer' | 'api-key'
  /** 预设里声明了推理开关：载入/切家以声明为准（authStyle 同款归位）。不声明 = 用户自己管。 */
  reasoning?: boolean
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseUrl: 'https://api.deepseek.com',
    model: 'deepseek-chat',
    needsKey: true
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    model: 'gpt-4o-mini',
    needsKey: true
  },
  {
    id: 'ollama',
    label: 'Ollama (local)',
    baseUrl: 'http://localhost:11434/v1',
    model: 'qwen2.5:7b',
    needsKey: false
  },
  {
    id: 'mimo',
    label: 'MiMo (Xiaomi)',
    baseUrl: 'https://api.xiaomimimo.com/v1',
    model: 'mimo-v2.6-flash',
    needsKey: true,
    authStyle: 'api-key'
  },
  {
    id: 'zhipu',
    label: 'GLM (智谱 BigModel · 免费)',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    model: 'glm-4-flash-250414',
    needsKey: true
  },
  {
    id: 'ark',
    label: '豆包 (火山方舟)',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/v3',
    model: 'doubao-seed-2-0-mini-260428',
    needsKey: true
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible)',
    baseUrl: '',
    model: '',
    needsKey: true
  }
]

/**
 * 载入归位：供应商三件套（authStyle / key 表 / 推理表）的漂移仲裁都收在这一处，
 * normalizeSettings 只剩一行委托。就地改 merged，不返回副本——和归一化的其余规则同一风格。
 */
export function healProvider(merged: AppSettings): void {
  // 换预设会残留上一家的 authStyle（MiMo 的 api-key 头风格）：GLM 收不到 Authorization 报 401。
  // 面板从不单独编辑 authStyle，一律以预设声明的为准，存档里的野值在这里归位。
  const preset = PROVIDER_PRESETS.find((item) => item.id === merged.provider.id)
  if (preset && merged.provider.authStyle !== preset.authStyle) merged.provider.authStyle = preset.authStyle
  // 漂移仲裁（#42）：活值非空时永远写回表里——用户手编了 settings.json 的 key，要以手编的为准，
  // 否则切走再切回来，表里那把旧 key 会复活。空串/缺失则不碰表——空值不许顶掉已记住的 key。
  // 旧的「仅缺项时播种」迁移（无条目 + 非空活值）是这条规则的特例，自然归入其中。
  if (!merged.providerKeys || typeof merged.providerKeys !== 'object') merged.providerKeys = {}
  if (merged.provider.apiKey) merged.providerKeys[merged.provider.id] = merged.provider.apiKey
  // 推理存档（#43）：形状与 key 表相同，同样先兜底。预设表声明了 reasoning 的家以声明为准
  // （authStyle 同款归位，活值与存档一起归位）；没声明的预设与 custom 保留用户值，开关仍可各家各编辑。
  if (!merged.providerReasoning || typeof merged.providerReasoning !== 'object') merged.providerReasoning = {}
  const healedReasoning = healProviderReasoning(
    merged.provider.id,
    merged.provider.reasoning,
    preset,
    merged.providerReasoning
  )
  merged.provider.reasoning = healedReasoning.reasoning
  merged.providerReasoning = healedReasoning.providerReasoning
}
