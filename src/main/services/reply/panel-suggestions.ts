import type { PanelSuggestionsResult } from '@shared/ipc'
import { errorMessage } from '@shared/errors'
import { chatCompletion } from '../providers/openai-compat'
import { loadSettings } from '../settings'
import { getCaptureService } from '../capture/capturer'

/**
 * 呼出面板的「AI 建议」：拿最近几条聊天原文当上下文，生成 2–3 条可直接复制的
 * 英文短句。失败返回 error 让浮层显重试，绝不静默空表——按了没反应比报错更糟。
 */
const CONTEXT_ROWS = 6

const SUGGEST_SYSTEM_PROMPT =
  'You suggest short Dota 2 team-chat replies in English. Given recent chat, propose 2-3 natural, ' +
  'polite, game-appropriate lines. Each line: at most 12 words, no quotes, no numbering, one per line. ' +
  'Output ONLY the lines.'

/** 最近聊天原文 → 上下文块；只取别人的话（own 行是玩家自己打的，当建议语境没意义）。 */
function contextBlock(): string {
  const rows = getCaptureService()
    .history()
    .filter((entry) => !entry.own && entry.original)
    .slice(-CONTEXT_ROWS)
  if (rows.length === 0) return '(no recent chat — propose generic encouraging team lines)'
  return rows.map((entry) => `- ${entry.original}`).join('\n')
}

/** 模型可能回 ``` 或编号：剥掉一切非正文行，最多取 3 条。 */
function parseSuggestions(answer: string): string[] {
  return answer
    .split('\n')
    .map((line) => line.replace(/^\s*(?:[-*\d.、)]+\s*)?/, '').trim())
    .filter((line) => line.length > 0 && line.length <= 120)
    .slice(0, 3)
}

export async function generatePanelSuggestions(): Promise<PanelSuggestionsResult> {
  try {
    const settings = loadSettings()
    const answer = await chatCompletion({
      provider: settings.provider,
      messages: [
        { role: 'system', content: SUGGEST_SYSTEM_PROMPT },
        { role: 'user', content: contextBlock() }
      ],
      maxTokens: 120
    })
    const items = parseSuggestions(answer)
    if (items.length === 0) return { ok: false, items: [], error: '模型没有给出可用建议' }
    return { ok: true, items }
  } catch (err) {
    return { ok: false, items: [], error: errorMessage(err) }
  }
}
