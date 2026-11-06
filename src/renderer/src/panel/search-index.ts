import { SECTION_GROUPS, SECTIONS, type SectionId } from './sections'

/**
 * Ctrl+K 的搜索索引：分区表是唯一权威，关键词只是补充别名。
 * 别名只写「用户会怎么叫它」，不复制页面里每一行的字面标签——
 * 那样每改一行文案就得改两处，必然漂移。平铺组的行靠分区级关键词
 * 覆盖；只有折叠组里的行单独登记（COLLAPSED_ROWS），命中时顺带展开。
 */

/** 每个分区补几个常用叫法：中英文、口语、旧版叫法都算。 */
const KEYWORDS: Record<SectionId, string[]> = {
  overview: ['自检', '状态', '四条链路', 'status'],
  engine: [
    'api key', 'key', '密钥', '模型', 'deepseek', 'openai', 'ollama', 'mimo', '智谱',
    'glm', '自定义', '代理', 'proxy', '推理', '思考', '词数', '缓存', '试验台', '试翻'
  ],
  talk: ['麦克风', '说话键', '语音输入', 'asr', 'whisper', 'qwen3', '热词', '识别', '音色包', 'gpt-sovits'],
  chatout: ['直发', '发送', '回车', 'enter', '语气', '回复'],
  read: ['朗读', 'tts', '念出来', '嗓子', '音色', 'edge', 'offline', '语速', '音高', '试听'],
  overlay: ['浮层', '透明窗', '锁定', '收起', '位置', '透明度', '点击', '昵称', '自动捕获'],
  hotkeys: ['快捷键', '热键', '组合键', 'global shortcut', 'accelerator', '绑定'],
  about: ['版本', '更新', '升级', 'nightly', '文档']
}

/**
 * 藏在折叠组里的行：这些词搜到了光跳页没用，还得把组翻开。
 * group 的值 = CollapsibleGroup 的 id，登记在这里的行才享受「命中即展开」。
 */
const COLLAPSED_ROWS: { section: SectionId; group: string; words: string[] }[] = [
  { section: 'read', group: 'read.behavior', words: ['自己的话', '积压', '刷屏', '分句', '段长'] },
  { section: 'read', group: 'read.speaker', words: ['说话人', '模板', 'who', '玩家9'] },
  { section: 'read', group: 'read.offline', words: ['离线模型', '下载模型', '130'] },
  { section: 'overlay', group: 'overlay.notes', words: ['截图', '看不见', '穿透'] }
]

export interface SearchHit {
  id: SectionId
  title: string
  hint: string
  /** 命中的是哪个词——列表里原样显示，帮人确认没搜错。 */
  matched: string
  /** 命中的行在折叠组里时带组 id：跳页前先展开它，人才看得见命中的行。 */
  group?: string
}

export function searchSections(query: string): SearchHit[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const hits: SearchHit[] = []
  for (const section of SECTIONS) {
    const group = SECTION_GROUPS.find((g) => g.ids.includes(section.id))?.label ?? ''
    const collapsed = COLLAPSED_ROWS.filter((row) => row.section === section.id)
    const collapsedWords = collapsed.flatMap((row) => row.words)
    const haystack = [section.title, section.hint, group, ...KEYWORDS[section.id], ...collapsedWords]
    const matched = haystack.find((word) => word.toLowerCase().includes(q))
    if (matched) {
      // 命中的词若属于某个折叠组，把组 id 带上：光跳页看不见行。
      const owner = collapsed.find((row) => row.words.some((w) => w.toLowerCase() === matched.toLowerCase()))
      hits.push({ id: section.id, title: section.title, hint: section.hint, matched, group: owner?.group })
    }
  }
  return hits
}
