/**
 * 原型的导航模型：真面板十页 + 「这台机器的接线」。
 *
 * 十二页：真面板的十页 + 音色包（替掉那个三 tab 弹窗）+ 这台机器的接线（`src/renderer/src/panel/pages/*.tsx` 一一对应），
 * 编号只用来排序，不用来表达优先级。
 */

export type Screen =
  | 'helm'
  | 'bare'
  | 'board'
  | 'overview'
  | 'talk'
  | 'read'
  | 'overlay'
  | 'chatout'
  | 'engine'
  | 'voice'
  | 'packs'
  | 'asr'
  | 'hotkeys'
  | 'about'
  | 'wire'

export type NavItem = {
  id: Screen
  label: string
  /** 右侧那句「这页一句话是干什么的」 */
  note: string
  /** 需要盯的角标（异常数、键位数、过期等），空字符串不显示 */
  badge?: string
  /** 角标的颜色语义 */
  tone?: 'ok' | 'warn' | 'bad'
}

/**
 * 新形态：这一局。它是产品默认落地的那一屏 ——
 * 打开应用先看到「现在该做什么」，而不是十页设置。
 */
export const NOW: NavItem[] = [
  { id: 'helm', label: '这一局', note: '18:42 · 落后 3.1k', badge: '肉山 40s', tone: 'warn' },
  { id: 'bare', label: '无窗口形态', note: '只有一条 132×34' },
  { id: 'board', label: '副屏', note: '第二块屏上 320 宽' }
]

/** 对局里：只在屏幕上出现的那两样东西。其余一切都不属于对局。 */
export const MATCH: NavItem[] = [
  { id: 'overlay', label: '浮层', note: '屏幕上那一层' },
  { id: 'chatout', label: '直发', note: '打字送进去' }
]

/**
 * 平时：开赛前调一次、之后基本不动的东西。
 * 「说话 / 听话」两页也在这里 —— 它们是对局中按热键就发生的事，
 * 但「设置它们」是平时的事；对局中要改，走驾驶室那 6 项抽屉。
 */
export const STUDIO: NavItem[] = [
  { id: 'talk', label: '它怎么听 · 说', note: '36 行 → 抽屉 6 项' },
  { id: 'read', label: '它怎么念', note: '别人的字要不要念' },
  { id: 'engine', label: '翻译引擎', note: 'DeepSeek' },
  { id: 'voice', label: '音色训练', note: 'GPT-SoVITS', badge: '待注册', tone: 'warn' },
  { id: 'packs', label: '音色包', note: '4 个 · 有更新', badge: '1 条更新', tone: 'warn' },
  { id: 'asr', label: '识别训练', note: 'Qwen3' }
]

/** 系统：出问题时才看的两页。 */
export const SYS: NavItem[] = [
  { id: 'overview', label: '体检', note: '四条链路', badge: '1 条异常', tone: 'warn' },
  { id: 'wire', label: '这台机器的接线', note: '七段' },
  { id: 'hotkeys', label: '热键', note: '7 条' },
  { id: 'about', label: '关于', note: 'v1.2.0' }
]

export const ALL: NavItem[] = [...NOW, ...MATCH, ...STUDIO, ...SYS]

export const isScreen = (raw: string | null): raw is Screen => ALL.some((item) => item.id === raw)
