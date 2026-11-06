/**
 * 面板 v2 的分区表：侧边栏、路由、搜索索引都只认这一份。
 * 加一页 = 这里加一行 + panel-app.tsx 里加一个 case。
 */
export const SECTIONS = [
  { id: 'overview', title: '总览', hint: '四种链路的当前状态' },
  { id: 'engine', title: '翻译引擎', hint: '模型服务与试验台' },
  { id: 'talk', title: '对讲', hint: '我说给别人听' },
  { id: 'chatout', title: '直发', hint: '打字发进聊天框' },
  { id: 'read', title: '朗读', hint: '我听别人说' },
  { id: 'overlay', title: '浮层', hint: '对局里那块透明窗' },
  { id: 'hotkeys', title: '热键', hint: '面板与动作键' },
  { id: 'about', title: '关于', hint: '版本与更新' }
] as const

export type SectionId = (typeof SECTIONS)[number]['id']

export const DEFAULT_SECTION: SectionId = 'overview'

/** 侧边栏分组：对局三页在前，系统三页在后，总览与关于各占一头。 */
export const SECTION_GROUPS: { label: string; ids: SectionId[] }[] = [
  { label: '对局', ids: ['talk', 'chatout', 'read', 'overlay'] },
  { label: '系统', ids: ['engine', 'hotkeys'] }
]

export function isSectionId(value: string | null): value is SectionId {
  return SECTIONS.some((s) => s.id === value)
}
