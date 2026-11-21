/**
 * 浮层可读性的纯缝（#100）：三档字号、文字配色对、WCAG 对比度。
 *
 * 为什么要有这一层：字号与颜色原本只写在 overlay.css 里，探针无从下手；把「四档字号 × 三档」与
 * 「每一对文字色 / 底色」搬到这里，面板的字号按钮、浮层的 data-font、探针的 AA 断言读的是同一张表。
 *
 * 探针能测与不能测，写清楚免得后人以为测过了：
 * - 能测：文字色相对「行底色叠在纯黑上」的对比度、三档字号是否单调递增且在最小窗口内装得下、
 *   哪些状态还靠颜色以外的东西区分。
 * - 不能测：游戏画面本身亮不亮。行底色默认 0.34 不透明度，背后是实况画面；亮场景靠
 *   text-shadow 兜底，那一点没法在离屏算出来，所以这里不假装能测（别把「AA 通过」当成
 *   「任何画面上都看得清」）。
 */

import { OVERLAY_MIN_HEIGHT, OVERLAY_MIN_WIDTH } from './overlay-geometry'

export type OverlayFontSize = 'small' | 'normal' | 'large'

/** 三档的顺序就是面板按钮的顺序：小 → 标准 → 大。 */
export const OVERLAY_FONT_SIZES: readonly OverlayFontSize[] = ['small', 'normal', 'large']

/** 一档里四个字号档位（px）：与 overlay.css 的 --ov-fs-* 一一对应，改一处必须改另一处。 */
export interface OverlayFontScale {
  /** 小标签（「词」「？」「中」这类角标） */
  mini: number
  /** 次要行（阶段留痕、已播、提示行） */
  small: number
  /** 原文行 */
  body: number
  /** 译文行（浮层的主角，永远比原文大一号） */
  title: number
}

const FONT_SCALE: Record<OverlayFontSize, OverlayFontScale> = {
  small: { mini: 9, small: 10, body: 11, title: 12 },
  normal: { mini: 10, small: 11, body: 12, title: 13 },
  large: { mini: 11, small: 12, body: 13.5, title: 14.5 }
}

/** 最大档相对最小档的上限：再大一行就只剩半句，浮层的价值是扫一眼而不是读文章。 */
export const OVERLAY_FONT_MAX_RATIO = 1.35

/** 最小窗口宽度下一行至少要装下这么多汉字，否则读起来是碎词而不是句子。 */
export const OVERLAY_MIN_CHARS_PER_LINE = 12

/** 一行的竖直开销：上下 padding 6×2 + 译文与原文之间的 2px 间隙。 */
const ROW_VERTICAL_PAD = 14
/** 两行文字的 line-height（.orig / .trans 都是 1.4）。 */
const ROW_LINE_HEIGHT = 1.4

export function normalizeOverlayFontSize(value: unknown): OverlayFontSize {
  return value === 'small' || value === 'large' ? value : 'normal'
}

export function overlayFontScale(size: OverlayFontSize): OverlayFontScale {
  return FONT_SCALE[size]
}

/** 原文 + 译文都在的一行的最坏高度：大档也得在最小窗口里至少完整显示一行（列表靠底部对齐）。 */
export function overlayRowHeight(size: OverlayFontSize): number {
  const scale = overlayFontScale(size)
  return Math.ceil(ROW_VERTICAL_PAD + (scale.body + scale.title) * ROW_LINE_HEIGHT)
}

/** 最小窗口宽度下一行能装几个汉字：汉字按 1 个字宽 ≈ 字号算，两侧 padding 各 10。 */
export function overlayCharsPerLine(size: OverlayFontSize, width = OVERLAY_MIN_WIDTH): number {
  const usable = width - 20
  return Math.floor(usable / overlayFontScale(size).title)
}

export interface FontStepCheck {
  size: OverlayFontSize
  scale: OverlayFontScale
  rowHeight: number
  charsPerLine: number
  /** 一行装得进最小窗口高度（列表底部对齐时最后一行不被切掉）。 */
  fitsHeight: boolean
  /** 一行装得下足够多的字。 */
  fitsWidth: boolean
  /** 相对最小档的最大放大倍数（同一个档位比）。 */
  growth: number
}

export interface FontStepReport {
  steps: FontStepCheck[]
  failures: string[]
}

/** 三档字号是否都「装在最小窗口里」：探针与 check:pure 共用这一份判据。 */
export function judgeOverlayFontSteps(): FontStepReport {
  const heights = OVERLAY_MIN_HEIGHT - 16
  const base = overlayFontScale('small')
  const steps = OVERLAY_FONT_SIZES.map((size) => {
    const scale = overlayFontScale(size)
    const rowHeight = overlayRowHeight(size)
    const charsPerLine = overlayCharsPerLine(size)
    const growth = Math.max(
      scale.mini / base.mini,
      scale.small / base.small,
      scale.body / base.body,
      scale.title / base.title
    )
    return {
      size,
      scale,
      rowHeight,
      charsPerLine,
      fitsHeight: rowHeight <= heights,
      fitsWidth: charsPerLine >= OVERLAY_MIN_CHARS_PER_LINE,
      growth: Math.round(growth * 1000) / 1000
    }
  })
  const failures: string[] = []
  for (const step of steps) {
    if (!step.fitsHeight) failures.push(`${step.size}：一行 ${step.rowHeight}px 超过最小窗口 ${heights}px`)
    if (!step.fitsWidth) failures.push(`${step.size}：一行只装 ${step.charsPerLine} 个字（下限 ${OVERLAY_MIN_CHARS_PER_LINE}）`)
    if (step.growth > OVERLAY_FONT_MAX_RATIO) failures.push(`${step.size}：放大到 ${step.growth} 倍，超过上限 ${OVERLAY_FONT_MAX_RATIO}`)
  }
  return { steps, failures }
}

/* ── 颜色与对比度 ─────────────────────────────────────────────────── */

type Rgb = { r: number; g: number; b: number; a: number }

/** 浮层的几块底色（与 overlay.css 一致）：文字对比一律相对它们算。 */
export const ROW_BACKDROP = 'rgba(12,10,9,0.34)'
export const STAGE_BACKDROP = 'rgba(10,8,6,0.72)'
export const PANEL_BACKDROP = 'rgba(10,10,12,0.96)'
/** 浮层挂在透明窗口上，能确定的只有「背后至少是黑的」——所以基准按叠在纯黑上算。 */
export const OVERLAY_BASE = '#000000'

/**
 * 一对文字色 / 底色。`bg` 是「底色叠在纯黑上」之后的实色，`fg` 允许带 alpha
 * （带 alpha 时会先叠到底色上再算——半透明白字压在暗底上和纯白字不是一回事）。
 */
export interface ContrastPair {
  /** 报告里给人看的名字 */
  name: string
  /** overlay.css 里对应哪个选择器，改色时按这个找 */
  token: string
  fg: string
  bg: string
  /** WCAG AA：正文 4.5（这里没有 24px 以上的大字，所以一律按正文算） */
  minimum: number
}

export const AA_NORMAL = 4.5
export const AA_LARGE = 3

/** 十对必须达标的文字：覆盖原文/译文/角标/失败/阶段/播报/面板。 */
export const OVERLAY_TEXT_PAIRS: readonly ContrastPair[] = [
  { name: '原文', token: '.orig', fg: 'rgba(231,229,228,0.92)', bg: ROW_BACKDROP, minimum: AA_NORMAL },
  { name: '译文', token: '.trans', fg: '#f5f0e0', bg: ROW_BACKDROP, minimum: AA_NORMAL },
  { name: '译文 · 词库命中', token: '.trans.cached', fg: '#e8dfb8', bg: ROW_BACKDROP, minimum: AA_NORMAL },
  { name: '「词」角标', token: '.trans.cached::before', fg: '#fcd34d', bg: 'rgba(251,191,36,0.18)', minimum: AA_NORMAL },
  { name: '「？」缺名词', token: '.keynoun', fg: '#fdba74', bg: 'rgba(251,146,60,0.16)', minimum: AA_NORMAL },
  { name: '方向角标', token: '.trans .dir', fg: '#94a3b8', bg: 'rgba(148,163,184,0.14)', minimum: AA_NORMAL },
  { name: '失败行', token: '.trans.err', fg: '#f87171', bg: ROW_BACKDROP, minimum: AA_NORMAL },
  { name: '阶段留痕', token: '.trace', fg: 'rgba(253,230,138,0.75)', bg: ROW_BACKDROP, minimum: AA_NORMAL },
  { name: '播报 · 已播', token: '.spoken.ok', fg: '#86efac', bg: ROW_BACKDROP, minimum: AA_NORMAL },
  { name: '播报 · 未播', token: '.spoken.err', fg: '#f87171', bg: ROW_BACKDROP, minimum: AA_NORMAL },
  { name: '阶段行', token: '#stage', fg: 'rgba(255,255,255,0.85)', bg: STAGE_BACKDROP, minimum: AA_NORMAL },
  { name: '阶段行 · 警告', token: '#stage.warn', fg: 'rgba(253,230,138,0.95)', bg: STAGE_BACKDROP, minimum: AA_NORMAL },
  { name: '空态提示', token: '.row.hint', fg: 'rgba(214,211,209,0.7)', bg: 'rgba(12,10,9,0.5)', minimum: AA_NORMAL },
  { name: '未读角标', token: '.unread', fg: '#1c1917', bg: 'rgba(251,191,36,0.9)', minimum: AA_NORMAL },
  { name: '面板脚注', token: '.panel-note', fg: 'rgba(148,163,184,0.85)', bg: PANEL_BACKDROP, minimum: AA_NORMAL }
]

export function parseColor(value: string): Rgb | null {
  const text = value.trim().toLowerCase()
  const hex = /^#([0-9a-f]{6})$/.exec(text)
  if (hex !== null) {
    const n = Number.parseInt(hex[1], 16)
    return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff, a: 1 }
  }
  const short = /^#([0-9a-f]{3})$/.exec(text)
  if (short !== null) {
    const [r, g, b] = short[1].split('')
    return { r: Number.parseInt(r + r, 16), g: Number.parseInt(g + g, 16), b: Number.parseInt(b + b, 16), a: 1 }
  }
  const fn = /^rgba?\(([^)]+)\)$/.exec(text)
  if (fn === null) return null
  const parts = fn[1].split(',').map((part) => Number.parseFloat(part.trim()))
  if (parts.length < 3 || parts.some((part) => Number.isNaN(part))) return null
  return { r: parts[0], g: parts[1], b: parts[2], a: parts[3] ?? 1 }
}

/** 把 `fg`（可有 alpha）叠到不透明的 `bg` 上，得到实际看到的颜色。 */
export function compositeOver(fg: string, bg: string): Rgb {
  const top = parseColor(fg)
  const bottom = parseColor(bg)
  if (top === null || bottom === null) return { r: 0, g: 0, b: 0, a: 1 }
  const a = top.a
  return {
    r: Math.round(top.r * a + bottom.r * (1 - a)),
    g: Math.round(top.g * a + bottom.g * (1 - a)),
    b: Math.round(top.b * a + bottom.b * (1 - a)),
    a: 1
  }
}

function channel(component: number): number {
  const c = component / 255
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}

/** WCAG 相对亮度：0（黑）到 1（白）。 */
export function relativeLuminance(value: string, behind = OVERLAY_BASE): number {
  const solid = compositeOver(value, behind)
  return 0.2126 * channel(solid.r) + 0.7152 * channel(solid.g) + 0.0722 * channel(solid.b)
}

/** 两个颜色的对比度（1–21）。半透明的一方默认叠在纯黑上。 */
export function contrastRatio(fg: string, bg: string): number {
  // 底色先叠到纯黑上变成实色；文字再叠到这个实色上（半透明白字在暗底上本就变暗）。
  const solidBg = compositeOver(bg, OVERLAY_BASE)
  const solidFg = compositeOver(fg, `rgb(${solidBg.r},${solidBg.g},${solidBg.b})`)
  const lumFg = 0.2126 * channel(solidFg.r) + 0.7152 * channel(solidFg.g) + 0.0722 * channel(solidFg.b)
  const lumBg = 0.2126 * channel(solidBg.r) + 0.7152 * channel(solidBg.g) + 0.0722 * channel(solidBg.b)
  const light = Math.max(lumFg, lumBg)
  const dark = Math.min(lumFg, lumBg)
  return Math.round(((light + 0.05) / (dark + 0.05)) * 100) / 100
}

export interface ContrastCheck extends ContrastPair {
  ratio: number
  passes: boolean
}

export interface ContrastReport {
  pairs: ContrastCheck[]
  failures: string[]
  /** 最差的那一对（名字 + 比值），周报只报这一个数也够 */
  worst: ContrastCheck
}

export function judgeOverlayContrast(pairs: readonly ContrastPair[] = OVERLAY_TEXT_PAIRS): ContrastReport {
  const checks = pairs.map((pair) => {
    const ratio = contrastRatio(pair.fg, pair.bg)
    return { ...pair, ratio, passes: ratio >= pair.minimum }
  })
  const failures = checks
    .filter((check) => !check.passes)
    .map((check) => `${check.name}（${check.token}）${check.ratio}:1，要求 ${check.minimum}:1`)
  const worst = checks.reduce((left, right) => (right.ratio < left.ratio ? right : left), checks[0])
  return { pairs: checks, failures, worst }
}

/* ── 状态不能只靠颜色区分 ─────────────────────────────────────────── */

/**
 * 每个「用颜色表达状态」的地方，必须还有颜色以外的东西：文字、符号或形状。
 * 色弱的人分不出绿/红，灰度截图里更是全都一样；少了这一列，两个状态就只剩颜色差。
 */
export interface StateMark {
  name: string
  token: string
  /** 颜色之外还靠什么区分：给人看的描述 */
  marker: string
  /** 标记落在哪：前缀符号 / 文案 / 形状 / 角标 */
  kind: 'prefix' | 'text' | 'shape' | 'badge'
}

export const OVERLAY_STATE_MARKS: readonly StateMark[] = [
  { name: '播报 · 已播', token: '.spoken.ok::before', marker: '✓', kind: 'prefix' },
  { name: '播报 · 未播', token: '.spoken.err::before', marker: '✕', kind: 'prefix' },
  { name: '失败行', token: '.trans.err', marker: '✕（渲染时写在文本里）', kind: 'prefix' },
  { name: '译文 · 词库命中', token: '.trans.cached::before', marker: '词', kind: 'badge' },
  { name: '「？」缺名词', token: '.keynoun', marker: '？+ 名词列表', kind: 'badge' },
  { name: '方向角标', token: '.trans .dir', marker: '中 / EN 文字', kind: 'badge' },
  { name: '录音中', token: '.voice-ring-filled', marker: '实心圆 + 「录音」', kind: 'shape' },
  { name: '朗读中', token: '.voice-ring-waves', marker: '声波 + 「在读」', kind: 'shape' },
  { name: '未读数', token: '.unread', marker: '数字本身', kind: 'text' },
  { name: '阶段行 · 警告', token: '#stage.warn', marker: '⚠ 前缀由 stageLine 写', kind: 'text' }
]

export interface StateMarkReport {
  marks: StateMark[]
  failures: string[]
}

export function judgeStateMarks(marks: readonly StateMark[] = OVERLAY_STATE_MARKS): StateMarkReport {
  const failures = marks
    .filter((mark) => mark.marker.trim() === '')
    .map((mark) => `${mark.name}（${mark.token}）只靠颜色，色弱与灰度下无法区分`)
  return { marks: [...marks], failures }
}
