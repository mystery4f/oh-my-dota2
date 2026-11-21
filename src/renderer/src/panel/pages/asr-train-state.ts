import type { AsrFtStatusResult } from '@shared/train/asr-ft'
import type { PreflightItem } from '@shared/train/preflight'
import type { TrainRunRecord } from '@shared/train/run'

/**
 * 识别训练页的状态纯函数缝：状态判定、首步选择、headline 文案与动作
 * 全部从同一份事实推导。页面（asr-train.tsx）只负责喂事实和转发，
 * 这里不碰 React、不碰 window.api——判定改了只改这一处，测试也只测这里。
 *
 * 判据只有一份（#173）：能不能开训、缺什么，一律取 `judgeAsrPreflight` 的结论
 * （`facts.blocks`），本文件**不养任何阈值常量**——「多少条算够」写在 preflight 里，
 * 这里只把它的 block 映射成一句话。`status.pending.count === 0` 这种是事实（还有几条没训），
 * 不是阈值。
 *
 * @author dongcheng.xie
 */

export type StepId = 'env' | 'data' | 'train' | 'live'

/**
 * 七态：页面永远先说清「现在在哪一步、下一步点哪里」。
 * `no-base` 是「选了增量但没有可续的上一轮权重」——开训按钮点不动，所以不能混进「可以开训」（#167）。
 */
export type PageState = 'env' | 'nodata' | 'no-base' | 'ready' | 'running' | 'live' | 'failed'

export interface HeadlineAction {
  label: string
  step: StepId
  disabled?: boolean
  run: () => void
}

export interface Headline {
  title: string
  hint: string
  action?: HeadlineAction
}

/** 页面喂进来的事实：状态快照、任务运行与否、最近一条训练记录、体检的阻断项、按钮忙。 */
export interface AsrTrainFacts {
  status: AsrFtStatusResult | null
  taskRunning: boolean
  task: { stage?: string; progress?: number } | null
  lastRun: TrainRunRecord | null
  /** `judgeAsrPreflight` 的阻断项（level === 'block'），映射成本页的状态，不再自己判阈值。 */
  blocks: readonly PreflightItem[]
  busy: boolean
}

export interface AsrTrainHandlers {
  startTraining: () => void
  stopTraining: () => void
  goData: () => void
  installEnv: () => void
  /** 「增量没有可续权重」的出口：切回全量，不是让用户去找设置。 */
  useFullMode: () => void
}

function blockOf(facts: AsrTrainFacts, id: string): PreflightItem | null {
  return facts.blocks.find((item) => item.id === id) ?? null
}

/**
 * 七态判定：环境 → 训练中 → 上次失败 → 增量没有起点 → 数据 → 现役/可开训。
 * 前三步里「缺环境」「增量没有起点」「一句都没录」都直接取 preflight 的 block 结论。
 * 一句都没录但有现役模型时仍说「现役已就位」——那时训练不是下一步要做的事。
 */
export function pageStateOf(facts: AsrTrainFacts): PageState {
  const { status } = facts
  if (!status) return 'env'
  if (blockOf(facts, 'env')) return 'env'
  if (facts.taskRunning) return 'running'
  if (facts.lastRun?.status === 'failed') return 'failed'
  if (blockOf(facts, 'incremental')) return 'no-base'
  if (blockOf(facts, 'rec')) return status.swap.activeExists ? 'live' : 'nodata'
  if (status.swap.activeExists && status.pending.count === 0) return 'live'
  return 'ready'
}

/** 首屏按状态选步，之后人点哪步就是哪步（页面用 ref 保证只跑一次）。状态没读到就不选。 */
export function firstStepOf(facts: AsrTrainFacts): StepId | null {
  const { status } = facts
  if (!status) return null
  if (!status.env.ok) return 'env'
  if (!status.swap.activeExists && status.pending.count === 0) return 'data'
  if (status.pending.count > 0) return 'train'
  return 'live'
}

/** 七态各自的标题/提示/主按钮：文案与判定同住一处，改提示不用翻组件。 */
export function headlineOf(facts: AsrTrainFacts, state: PageState, handlers: AsrTrainHandlers): Headline {
  const { status, task, lastRun } = facts
  if (state === 'env')
    return {
      title: '缺少训练环境',
      hint: `还差 ${status?.env.gaps.length ?? 0} 项依赖：装好才能开训，录音、纠错、打包都不受影响。`,
      action: { label: '安装环境', step: 'env', disabled: facts.busy || facts.taskRunning, run: handlers.installEnv }
    }
  if (state === 'nodata')
    return {
      title: '还没有可训练的数据',
      hint: '先录一组读稿：说完自动停，存完跳下一句；也可以写一句话再录。',
      action: { label: '去录音', step: 'data', run: handlers.goData }
    }
  if (state === 'no-base')
    return {
      title: '增量没有可续的权重',
      hint: blockOf(facts, 'incremental')?.detail ?? '没有可接的上一轮权重：先改成「全量重训」跑一轮',
      action: { label: '改成全量', step: 'train', disabled: facts.busy || facts.taskRunning, run: handlers.useFullMode }
    }
  if (state === 'running')
    return {
      title: '正在训练',
      hint: `${task?.stage || '准备中'} · ${task?.progress ?? 0}%｜中途停掉不会动现役模型`,
      action: { label: '停止', step: 'train', run: handlers.stopTraining }
    }
  if (state === 'failed')
    return {
      title: '上次训练失败了',
      hint: `${lastRun?.error ?? '记录里没写原因'}｜旧模型没动，改完再开一轮`,
      action: { label: '重试', step: 'train', disabled: facts.blocks.length > 0, run: handlers.startTraining }
    }
  if (state === 'live')
    return {
      title: '现役模型已就位',
      hint: `${status?.target.label ?? '微调模型'} 正在用｜有新录音时才需要再训一轮`
    }
  return {
    title: '可以开训',
    hint: `${status?.pending.label ?? ''}｜全量 ${status?.estimate.fresh.label ?? ''}，增量 ${status?.estimate.incremental.label ?? ''}`,
    action: { label: '开始训练', step: 'train', disabled: facts.blocks.length > 0, run: handlers.startTraining }
  }
}