import { formatMs } from './voice-timing'

/**
 * 对讲行的阶段留痕（voice-stage-trace）：这一句现在走到哪一段，之前每段各花了多久。
 *
 * 为什么是「留痕」而不是「每段停一会儿」：账本命中时翻译只有 1ms、缓存命中时合成 0–2ms
 * （data/logs/voice-chain.jsonl 实测 157 条里 36 条首音 < 250ms）。1ms 的文案在 60Hz 屏上
 * 连一帧都排不上（一帧 16.7ms），直显等于不显示；能不能看见还取决于事件落在刷新周期的哪个位置。
 * 留痕不占时间片——短段靠「不被下一段覆盖」存在，于是每个阶段都真的出现过。
 *
 * 快照而不是增量：主进程每完成一段就发一份完整快照，IPC 掉一条也只是少画一次，不会把行画歪。
 */
export type VoiceStage = 'translate' | 'synth' | 'playStart' | 'play' | 'done'

/** 已完成的一段：耗时由主进程的打点算出，不是渲染端自己掐的表。 */
export interface VoiceStageMark {
  stage: Exclude<VoiceStage, 'done'>
  ms: number
}

export interface VoiceStageProgress {
  marks: VoiceStageMark[]
  current: VoiceStage
}

export interface VoiceStageEvent extends VoiceStageProgress {
  /** 渲染端生成的行 id：只有带它，阶段才落得到那一条行上（面板/探针不传就不画）。 */
  rowId: string
}

/** 正在进行的那一段；`done` 不写文字——结算由行内第三行承担，不在这里平行重复一遍数字。 */
const CURRENT_LABEL: Record<VoiceStage, string> = {
  translate: '翻译中…',
  synth: '合成中…',
  playStart: '起播中…',
  play: '播放中…',
  done: ''
}

/** 已完成那一段的短标记：一个汉字 + 真实耗时，四个标记才占满一行。 */
const MARK_LABEL: Record<VoiceStageMark['stage'], string> = {
  translate: '译',
  synth: '合',
  playStart: '起',
  play: '播'
}

/** 行内后缀：`译 1ms · 合 2ms · 起 2.0s · 播放中…`；一段都还没有就是「翻译中…」。 */
export function formatStageTrace(progress: VoiceStageProgress): string {
  const parts = progress.marks.map((mark) => `${MARK_LABEL[mark.stage]} ${formatMs(mark.ms)}`)
  const current = CURRENT_LABEL[progress.current]
  if (current !== '') parts.push(current)
  return parts.join(' · ')
}
