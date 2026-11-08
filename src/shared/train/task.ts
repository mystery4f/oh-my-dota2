/**
 * 训练任务编排纯缝：任务类型与快照/请求契约、单任务互斥闸、推理互斥判定、计划推导。
 * 只做决策不碰进程——spawn/停止/日志环在主进程 services/train/manager.ts。
 * asr-ft / gv 两个子缝往 deriveTrainPlan 的 switch 里补真命令即可，结构不动。
 */
import { planAsrFtTrainArgv, type AsrFtDatasetPlan, type AsrFtPaths, type AsrFtTrainTuning } from './asr-ft'
import { GV_LEGS, type GvResolvedPaths, type GvTrainOptions } from './gv'
export type TrainTaskKind = 'demo' | 'asr-ft' | 'gv-gpt' | 'gv-sovits'

export type TrainTaskStatus = 'idle' | 'preparing' | 'running' | 'stopping' | 'done' | 'failed' | 'stopped'

export interface TrainTaskInfo {
  id: string
  kind: TrainTaskKind
  /** 数据集标识（T3 起是登记名，T1 只是面板里记下来的字符串）。 */
  dataset: string
  status: TrainTaskStatus
  /** 0–100；日志里拿不到量化进度时 -1。 */
  progress: number
  stage: string
  startedAt: number
  endedAt: number | null
  /** 互斥状态快照：任务在跑时 held/kept-off，退场后 released/release-failed，没碰过推理是 null。 */
  inference: InferenceHoldState | null
}

/**
 * 推理互斥状态（T2）：训练占卡期间 GV 推理让路的过程记录。
 * held = 应用托管的推理服务已被暂停；kept-off = 端口上的服务不是应用拉的（或没在跑），不动它；
 * released = 任务退干净后已恢复；release-failed = 恢复失败（引擎包不可用或启动超时）。
 */
export type InferenceHoldState = 'held' | 'kept-off' | 'released' | 'release-failed'

/** 训练窗口的互斥状态文案：一句解释「为什么暂时没声」，别让人以为应用坏了。 */
export function inferenceHoldLabel(state: InferenceHoldState): string {
  switch (state) {
    case 'held':
      return '推理已暂停（显存让给训练）'
    case 'kept-off':
      return '推理服务未由应用托管，训练期间保持原样'
    case 'released':
      return '推理已恢复'
    case 'release-failed':
      return '推理恢复失败：引擎包不可用或启动超时，可在面板查看服务日志后重试'
  }
}

export interface TrainLogLine {
  at: number
  text: string
}

export interface TrainSnapshot {
  task: TrainTaskInfo | null
  logs: TrainLogLine[]
}

export interface TrainStartRequest {
  kind: TrainTaskKind
  dataset: string
  /** asr-ft 专用：主进程检测环境 + 打包数据后填进来；没填就按「环境没就绪」拒启动。 */
  asrFt?: {
    paths: AsrFtPaths
    data: AsrFtDatasetPlan
    /** 导出产物目录（训练成功后链式导出写这里，应用新模型从这里拷）。 */
    exportDir: string
    /** 自适应轮数 / 续训点 / lr（备料服务算好填进来）；没填 = 冻结默认 66 轮 2e-5 新开。 */
    tuning?: AsrFtTrainTuning
  }
  /** asr-ft 专用：窗口上的「续训」开关；主进程备料时据此挑上次 checkpoint，失败自动落回新开。 */
  resume?: boolean
  /** gv-* 专用：窗口表单里的意图；主进程校验模板/底模/数据集后才转成 gvResolved。 */
  gv?: GvTrainOptions
  /** gv-* 专用：主进程写好训练配置后填（argv/cwd 全从这里来）；没填按环境没就绪拒启动。 */
  gvResolved?: GvResolvedPaths
}


export interface TrainStartResult {
  ok: boolean
  error: string | null
}

export interface TrainPlan {
  exe: string
  args: string[]
  cwd: string | null
  /** 非空 = 这个 kind 还没接真训练栈，启动会被拒绝。 */
  unavailable?: string
}

const TRAIN_KINDS: readonly TrainTaskKind[] = ['demo', 'asr-ft', 'gv-gpt', 'gv-sovits']

/** 单任务互斥：只有没有任务、或上一个任务已终态，才允许开新的。 */
export function canStartTrain(status: TrainTaskStatus | null): { ok: boolean; reason: string | null } {
  if (status === null) return { ok: true, reason: null }
  if (status === 'preparing' || status === 'running') return { ok: false, reason: `已有任务在跑（${status}），先停止再开新的` }
  if (status === 'stopping') return { ok: false, reason: '上一个任务还在停，等它退干净' }
  return { ok: true, reason: null }
}

/** 任务活着就要让 GV 推理让路（T2 接线；面板状态显示也用它）。 */
export function shouldPauseInference(status: TrainTaskStatus | null): boolean {
  return status === 'preparing' || status === 'running' || status === 'stopping'
}

/** 任务退干净（或根本没有任务）才恢复 GV 推理。 */
export function shouldResumeInference(status: TrainTaskStatus | null): boolean {
  return status === null || status === 'idle' || status === 'done' || status === 'failed' || status === 'stopped'
}

/** 乱值打回 demo（演示任务谁都能跑，拿它兜底最安全）。 */
export function normalizeTrainKind(value: unknown): TrainTaskKind {
  return typeof value === 'string' && (TRAIN_KINDS as readonly string[]).includes(value) ? (value as TrainTaskKind) : 'demo'
}

/**
 * 演示任务：node 内联脚本，每 500ms 吐一行 `epoch i/10`，5 秒收工 exit 0。
 * 够把「spawn → 日志 → 进度 → 完成 → 能停」整条生命周期走一遍，又不碰任何真训练栈。
 */
export const DEMO_TRAIN_SCRIPT = [
  'const n = 10',
  'let i = 0',
  'console.log("preparing")',
  'const t = setInterval(() => {',
  '  i += 1',
  '  console.log(`epoch ${i}/${n}`)',
  '  if (i >= n) { clearInterval(t); console.log("done") }',
  '}, 500)'
].join('\n')

export function deriveTrainPlan(req: TrainStartRequest): TrainPlan {
  switch (req.kind) {
    case 'demo':
      return { exe: 'node', args: ['-e', DEMO_TRAIN_SCRIPT], cwd: null }
    case 'asr-ft': {
      const asr = req.asrFt
      if (!asr) {
        return { exe: '', args: [], cwd: null, unavailable: 'ASR 微调环境没就绪：先在训练窗口里把环境装好（并至少录一条句子）' }
      }
      return { exe: asr.paths.pythonExe, args: planAsrFtTrainArgv(asr.paths, asr.data, asr.tuning), cwd: null }
    }
    case 'gv-gpt':
    case 'gv-sovits': {
      const gv = req.gvResolved
      if (!gv) {
        return {
          exe: '',
          args: [],
          cwd: null,
          unavailable: 'GV 微调环境没就绪：先在面板装好引擎包，并确认数据集已在 GPT-SoVITS webui 里备完料（1abc 三步）'
        }
      }
      return {
        exe: gv.pythonExe,
        args: ['-s', GV_LEGS[req.kind].script, GV_LEGS[req.kind].configFlag, gv.configFile],
        cwd: gv.home
      }
    }
    default:
      return { exe: '', args: [], cwd: null, unavailable: `未知任务类型：${String(req.kind)}` }
  }
}

