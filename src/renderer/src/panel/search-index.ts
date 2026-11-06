import { SECTION_GROUPS, SECTIONS, type SectionId } from './sections'

/**
 * Ctrl+K 的搜索索引：分区表是唯一权威，关键词只是补充别名。
 * 别名只写「用户会怎么叫它」，不复制页面里每一行的字面标签——
 * 那样每改一行文案就得改两处，必然漂移。行级直达等 M3/M4
 * 分组折叠出现后再挂，现在命中分区已经能解决「这在哪一页」。
 */

/** 每个分区补几个常用叫法：中英文、口语、旧版叫法都算。 */
const KEYWORDS: Record<SectionId, string[]> = {
  overview: ['自检', '状态', '四条链路', 'status'],
  engine: [
    'api key', 'key', '密钥', '模型', 'deepseek', 'openai', 'ollama', 'mimo', '智谱',
    'glm', '自定义', '代理', 'proxy', '推理', '思考', '词数', '缓存', '试验台', '试翻'
  ],
  talk: ['麦克风', '说话键', '语音输入', 'asr', 'whisper', 'qwen3', '热词', '识别'],
  chatout: ['直发', '发送', '回车', 'enter', '语气', '回复'],
  read: ['朗读', 'tts', '念出来', '嗓子', '音色', 'edge', 'offline'],
  overlay: ['浮层', '透明窗', '锁定', '收起', '位置', '透明度', '点击'],
  hotkeys: ['快捷键', '热键', '组合键', 'global shortcut', 'accelerator', '绑定'],
  about: ['版本', '更新', '升级', 'nightly', '文档']
}

export interface SearchHit {
  id: SectionId
  title: string
  hint: string
  /** 命中的是哪个词——列表里原样显示，帮人确认没搜错。 */
  matched: string
}

export function searchSections(query: string): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: SearchHit[] = []
  for (const section of SECTIONS) {
    const group = SECTION_GROUPS.find((g) => g.ids.includes(section.id))?.label ?? ''
    const haystack = [section.title, section.hint, group, ...KEYWORDS[section.id]]
    const matched = haystack.find((word) => word.toLowerCase().includes(q))
    if (matched) hits.push({ id: section.id, title: section.title, hint: section.hint, matched })
  }
  return hits
}
