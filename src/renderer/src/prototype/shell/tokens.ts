/**
 * 原型的视觉定稿：颜色、字号、间距三个表。
 *
 * 这里只放值，不放组件 —— 一个 .tsx 里出现第二个非组件导出会让 eslint 的
 * react-refresh 规则变红（本仓库同时只允许 1 条常驻警告），所以令牌单独一个文件。
 */

export const C = {
  /** 页面底 */
  bg: '#06080b',
  /** 左侧导航 */
  rail: '#090d11',
  /** 卡片 */
  card: '#0b1015',
  /** 卡片里再套一层（表头、代码块、警示条） */
  card2: '#0e141b',
  line: 'rgba(255,255,255,0.07)',
  line2: 'rgba(255,255,255,0.12)',
  text: '#e9eff5',
  dim: '#79838f',
  /** 只给「选中 / 主操作 / 正常」 */
  accent: '#37e2a4',
  /** 只给「需要注意」 */
  warn: '#f2b233',
  /** 只给「坏了」 */
  danger: '#f2565b',
  /** 只给「信息、外链、遥测」 */
  info: '#64a8ff'
} as const

export const FS = {
  /** 卡片标题 / 页面标题 */
  title: 15,
  /** 行标签 */
  body: 13,
  /** 说明、次级信息 */
  small: 11.5,
  /** 角标、编号、键名 */
  mini: 10.5
} as const

export const SP = {
  /** 行内元素 */
  tight: 6,
  /** 行与行 */
  row: 10,
  /** 卡片内边距 */
  card: 14,
  /** 卡片与卡片 */
  gap: 10,
  /** 页面左右留白 */
  page: 22
} as const

/** 等宽：键名、id、命令、时间戳。 */
export const MONO = 'ui-monospace, SFMono-Regular, "Cascadia Mono", Consolas, monospace'
