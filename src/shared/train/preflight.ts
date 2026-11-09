import type { AsrFtMode } from './asr-ft'

/**
 * 开训体检：把「环境、数据、打包、模型槽、显存」四类事实收成一张清单。
 * 只有 block 阻止开训；warn 是「能做但会白跑」的提醒，比如数据太少、还没打包。
 */
export type PreflightLevel = 'ok' | 'warn' | 'block'

export interface PreflightItem {
  id: string
  level: PreflightLevel
  label: string
  detail: string
}

export interface AsrPreflightInput {
  env: { ok: boolean; gaps: string[] }
  /** 已录句子总数（所有组合计）。 */
  recordedLines: number
  /** 上一次打包的条数；null = 这次会话还没打过包。 */
  packed: { train: number; eval: number } | null
  /** 生效模型在不在。不在不拦训练：全量训完会新建一份，增量靠的是上一轮权重。 */
  activeModel: boolean
  /** 本次开训口径：从底模重训 / 接着上一轮权重（增量）。 */
  mode: AsrFtMode
  /** 上一轮的权重还在不在：增量要靠它，缺了就不能增量。 */
  incrementalAvailable: boolean
  /** 显存提示：非空就是一条件告警。 */
  vramNote: string | null
}

/** ASR 侧：环境 → 录音 → 打包 → 模型槽 → 显存。顺序固定，读起来就是开训前的检查单。 */
export function judgeAsrPreflight(input: AsrPreflightInput): PreflightItem[] {
  const items: PreflightItem[] = []
  items.push(
    input.env.ok
      ? { id: 'env', level: 'ok', label: '训练环境', detail: 'Python 与依赖齐全' }
      : { id: 'env', level: 'block', label: '训练环境', detail: `缺件：${input.env.gaps.join('、') || '未知'}` }
  )

  if (input.recordedLines === 0) {
    items.push({ id: 'rec', level: 'block', label: '录音', detail: '一句都没录：先在上面的录音行里录几条' })
  } else if (input.recordedLines < 10) {
    items.push({
      id: 'rec',
      level: 'warn',
      label: '录音',
      detail: `只有 ${input.recordedLines} 句，训出来的口音会很不稳；建议至少 10 句`
    })
  } else {
    items.push({ id: 'rec', level: 'ok', label: '录音', detail: `${input.recordedLines} 句` })
  }

  if (!input.packed || input.packed.train === 0) {
    items.push({ id: 'pack', level: 'warn', label: '数据集', detail: '还没打包：开训前会按当前录音重新打包一次' })
  } else {
    items.push({
      id: 'pack',
      level: 'ok',
      label: '数据集',
      detail: `训练 ${input.packed.train} 条 / 验证 ${input.packed.eval} 条`
    })
  }

  items.push(
    input.activeModel
      ? { id: 'model', level: 'ok', label: '生效模型', detail: '已就位；训完自动换成它' }
      : {
          id: 'model',
          level: 'warn',
          label: '生效模型',
          detail: '还没有现役模型：训完会新建一份（词表从底模借）'
        }
  )

  items.push(incrementalItemOf(input))

  if (input.vramNote) items.push({ id: 'vram', level: 'warn', label: '显存', detail: input.vramNote })
  return items
}

/**
 * 增量起点一行：选了增量却没有上一轮权重就是阻断（点下去只会白跑），
 * 没选增量时只当信息（有上一轮 = 可以省一半时间）。
 */
function incrementalItemOf(input: AsrPreflightInput): PreflightItem {
  if (input.mode === 'incremental') {
    return input.incrementalAvailable
      ? { id: 'incremental', level: 'ok', label: '增量起点', detail: '上一轮的权重在，接着训只纠这批新错（约 300 步）' }
      : {
          id: 'incremental',
          level: 'block',
          label: '增量起点',
          detail: '没有可接的上一轮权重：先从底模重训一次，或把开训方式改回「从底模重训」'
        }
  }
  return input.incrementalAvailable
    ? { id: 'incremental', level: 'ok', label: '增量起点', detail: '上一轮的权重还在：想省时间可以改成「接着上次权重」' }
    : { id: 'incremental', level: 'ok', label: '增量起点', detail: '还没有上一轮：第一次从底模训' }
}

export interface GvPreflightInput {
  expName: string
  missing: string[]
  /** 两腿各自的最近一次训练是否成功过（只看记录，不重扫目录）。 */
  gptTrained: boolean
  sovitsTrained: boolean
}

/** GV 侧：备料四件套 → 两条腿的完成情况。缺备料直接 block，缺一条腿只是提醒。 */
export function judgeGvPreflight(input: GvPreflightInput): PreflightItem[] {
  const items: PreflightItem[] = []
  items.push(
    input.missing.length === 0
      ? { id: 'data', level: 'ok', label: '备料', detail: '四件套齐全' }
      : { id: 'data', level: 'block', label: '备料', detail: `缺 ${input.missing.join('、')}` }
  )
  items.push(
    input.gptTrained
      ? { id: 'gpt', level: 'ok', label: 'GPT 腿', detail: '训过，权重在 GPT_weights_* 下' }
      : { id: 'gpt', level: 'ok', label: 'GPT 腿', detail: '还没训：先训语义腿，SoVITS 依赖它' }
  )
  items.push(
    input.sovitsTrained
      ? { id: 'sovits', level: 'ok', label: 'SoVITS 腿', detail: '训过，权重在 SoVITS_weights_* 下' }
      : { id: 'sovits', level: 'ok', label: 'SoVITS 腿', detail: '还没训' }
  )
  return items
}

/** 只有 block 拦开训——体检不该变成一堆「你确定吗」。 */
export function preflightBlocks(items: PreflightItem[]): PreflightItem[] {
  return items.filter((item) => item.level === 'block')
}
