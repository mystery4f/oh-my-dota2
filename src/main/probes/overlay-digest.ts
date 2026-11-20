/**
 * 战况摘要探针（#99）：纯字符串逻辑，不开窗、不看浮层。
 *
 * 锁三条：
 * - 摘要每一段都**出自**某条聊天行的文字（票面那句「不编造消息里没有的内容」在这里被逐字核对）；
 * - 意图明显的行排在前面，但最终顺序仍是时间顺序（同一批消息每次得到同一行摘要）；
 * - 关掉设置只是不画摘要行、回到逐行列表——摘要函数本身不变，所以「关掉」不会偷偷改文案。
 */
import type { LedgerRow } from '@shared/overlay-ledger'
import { DIGEST_CLIP, DIGEST_ROWS, digestCues, digestLine, digestRowText } from '@shared/overlay-digest'
import { reduceOverlay, overlayStateFromSettings } from '@shared/overlay-state'
import { DEFAULT_SETTINGS } from '@shared/settings-shape'
import { finishProbe, probeCases } from './harness'

/** 造一行：只要 digestRowText 会读的那几个字段。 */
function row(original: string, translated: string | null = null): LedgerRow {
  return { id: original, ts: 0, original, translated } as LedgerRow
}

export async function runOverlayDigestProbe(): Promise<void> {
  const { cases, push } = probeCases()

  const quiet = [row('gg'), row('nice'), row('haha'), row('ok')]
  const urgent = [row('gg'), row('mid is missing'), row('need 4 top'), row('nice')]
  const line = digestLine(urgent)
  push('摘要只搬已经在行里的话（逐段核对来源）', line.split(' +')[0].split(' · ').every((part) => urgent.some((item) => digestRowText(item).startsWith(part.replace(/…$/, '')))))
  push('摘要不超过抬头该有的句数', line.split(' +')[0].split(' · ').length <= DIGEST_ROWS)
  push('被省掉的行数写在尾巴上', line.endsWith('+2') || line.endsWith('+1') || line.endsWith('+0') === false)
  push('意图明显的两句都进了摘要，清汤寡水的被挤到 +N', line.includes('mid is missing') && line.includes('need 4 top') && !line.startsWith('gg'))
  push('命中一样多时后说的在前（聊天浮层要的是最新的那句）', line.indexOf('need 4 top') < line.indexOf('mid is missing'))
  push('有译文就用译文，没译文用原文', digestRowText(row('需要 tp', 'need tp')) === 'need tp' && digestRowText(row('需要 tp')) === '需要 tp')
  push('空列表给空串（浮层据此整行不画）', digestLine([]) === '')
  push('全是空文本也不画假摘要', digestLine([row('   '), row('')]) === '')
  push('同一批消息两次调用结果相同（稳定）', digestLine(urgent) === digestLine(urgent))
  push(
    '长句被截断而不是撑满一行',
    digestLine([row('需要上路支援并且中路要小心肉山附近有人在等'), row('x')]).length <= DIGEST_CLIP + 8
  )
  push('意图词表能数出命中数', digestCues('mid is missing') >= 1 && digestCues('gg') === 0)
  push('清汤寡水的消息也给得出摘要（退化到最近几行）', digestLine(quiet).length > 0)

  // —— 设置开关：关掉只影响画不画，摘要本身不变
  const base = overlayStateFromSettings({ ...DEFAULT_SETTINGS, overlayDigest: false })
  push('设置默认关（浮层形状不因这个票自己变）', DEFAULT_SETTINGS.overlayDigest === false && base.digest === false)
  const on = reduceOverlay({ type: 'set-digest', on: true }, base)
  push('打开写进设置文件', on.state.digest === true && on.persist.overlayDigest === true && on.changed)
  const off = reduceOverlay({ type: 'set-digest', on: false }, on.state)
  push('关掉也写盘，且广播一次', off.state.digest === false && off.persist.overlayDigest === false && off.changed)
  push('同一个值重复设置不写盘也不广播', reduceOverlay({ type: 'set-digest', on: false }, off.state).changed === false)
  push('这条事件不动鼠标规则（点得到就还是点得到）', on.clickThrough === false)

  finishProbe('OVERLAY_DIGEST_PROBE', cases)
}
