/**
 * #100 的验收入口：浮层文字对比度、三档字号、以及「状态不只靠颜色」。
 *
 * 这三件事全是纯函数判定（`src/shared/overlay-a11y.ts`），本来该进 `check:pure`——它也进了。
 * 这里再包一层探针，是因为票面的验收口径写的就是「Probe：每一对文字的对比度不低于 AA」，
 * 运维与评审看的是 `npm run probe -- --overlay-a11y-probe` 的输出，不是 lint 的尾巴。
 */
import {
  AA_NORMAL,
  OVERLAY_FONT_MAX_RATIO,
  OVERLAY_FONT_SIZES,
  OVERLAY_MIN_CHARS_PER_LINE,
  OVERLAY_TEXT_PAIRS,
  compositeOver,
  contrastRatio,
  judgeOverlayContrast,
  judgeOverlayFontSteps,
  judgeStateMarks,
  normalizeOverlayFontSize,
  overlayFontScale,
  relativeLuminance,
  type ContrastPair
} from '@shared/overlay-a11y'
import { finishProbe, probeCases } from './harness'

export function runOverlayA11yProbe(): void {
  const { cases, push } = probeCases()

  // —— 对比度：每一对文字都要 ≥ AA ——
  const contrast = judgeOverlayContrast()
  push(
    '每一对文字对比度都 ≥ AA',
    contrast.failures.length === 0,
    contrast.failures.length === 0 ? `${contrast.pairs.length} 对全过` : contrast.failures.join('；')
  )
  push('最差的那一对也 ≥ AA', contrast.worst.passes, `${contrast.worst.name} ${contrast.worst.ratio}:1`)
  push('覆盖到浮层所有文字位置', contrast.pairs.length >= 12, `${contrast.pairs.length} 对`)
  push(
    'AA 门槛按正文 4.5',
    OVERLAY_TEXT_PAIRS.every((pair) => pair.minimum === AA_NORMAL),
    `minimum = ${AA_NORMAL}`
  )

  // 一对故意不达标的颜色必须被点名，否则「全过」可能只是判据没生效。
  const rigged: ContrastPair[] = [
    { name: '故意压暗的灰', token: 'probe', fg: '#3a3a3a', bg: '#2b2b2b', minimum: AA_NORMAL }
  ]
  const riggedReport = judgeOverlayContrast(rigged)
  push('不达标的颜色会被点名', riggedReport.failures.length === 1, riggedReport.failures[0] ?? '没有报')

  push('黑白对比度是 21', contrastRatio('#ffffff', '#000000') === 21)
  push('同色对比度是 1', contrastRatio('#808080', '#808080') === 1)
  push('黑的相对亮度是 0', relativeLuminance('#000000') === 0)
  push('白的相对亮度是 1', relativeLuminance('#ffffff') === 1)
  push(
    '半透明字先叠到底色上再算',
    compositeOver('rgba(255,255,255,0.5)', '#000000').r === 128,
    String(compositeOver('rgba(255,255,255,0.5)', '#000000').r)
  )

  // —— 三档字号：单调、而且在最小窗口里装得下 ——
  const steps = judgeOverlayFontSteps()
  push('三档都在最小窗口里装得下', steps.failures.length === 0, steps.failures.join('；') || '小/标准/大三档')
  const sizes = OVERLAY_FONT_SIZES.map((size) => overlayFontScale(size).title)
  push(
    '字号从小到大单调递增',
    sizes.every((value, index) => index === 0 || value > sizes[index - 1]),
    sizes.join(' → ')
  )
  push(
    `最大档不超过最小档 ${OVERLAY_FONT_MAX_RATIO} 倍`,
    steps.steps.every((step) => step.growth <= OVERLAY_FONT_MAX_RATIO),
    steps.steps.map((step) => `${step.size}:${step.growth}`).join(' ')
  )
  push(
    '每档一行至少装 12 个字',
    steps.steps.every((step) => step.charsPerLine >= OVERLAY_MIN_CHARS_PER_LINE),
    steps.steps.map((step) => `${step.size}:${step.charsPerLine} 字`).join(' ')
  )
  push(
    '大档一行完整显示在最小高度内',
    steps.steps.every((step) => step.fitsHeight),
    steps.steps.map((step) => `${step.size}:${step.rowHeight}px`).join(' ')
  )
  push('脏值回落 normal', normalizeOverlayFontSize('huge') === 'normal' && normalizeOverlayFontSize(undefined) === 'normal')
  push('合法的档位原样返回', normalizeOverlayFontSize('large') === 'large' && normalizeOverlayFontSize('small') === 'small')

  // —— 状态不能只靠颜色 ——
  const marks = judgeStateMarks()
  push('每个有颜色的状态都有颜色以外的标记', marks.failures.length === 0, marks.failures.join('；') || `${marks.marks.length} 处`)
  push(
    '已播 / 未播靠 ✓ ✕ 而不只是绿红',
    marks.marks.some((mark) => mark.token === '.spoken.ok::before' && mark.marker === '✓') &&
      marks.marks.some((mark) => mark.token === '.spoken.err::before' && mark.marker === '✕')
  )
  push(
    '录音 / 朗读靠环形而不是两种颜色',
    marks.marks.some((mark) => mark.kind === 'shape' && mark.token === '.voice-ring-filled') &&
      marks.marks.some((mark) => mark.kind === 'shape' && mark.token === '.voice-ring-waves')
  )

  finishProbe('OVERLAY_A11Y_PROBE', cases, {
    worstContrast: `${contrast.worst.token} ${contrast.worst.ratio}:1`,
    steps: steps.steps.map((step) => `${step.size}:${step.scale.title}px`)
  })
}
