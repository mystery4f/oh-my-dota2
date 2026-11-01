/**
 * 训练决策纯缝：任务计划推导、单任务互斥闸、日志行→进度解析、推理互斥判定。
 * 只做决策不碰进程——spawn/停止/日志环在主进程 services/train/manager.ts；
 * T3（GV 微调）/T5（ASR 微调）往 deriveTrainPlan 的 switch 里补真命令即可，结构不动。
 */

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
    case 'asr-ft':
      return { exe: '', args: [], cwd: null, unavailable: 'ASR 训练在 T5 接入（先手动跑通 qwen3_asr_sft.py 再上窗口）' }
    case 'gv-gpt':
    case 'gv-sovits':
      return { exe: '', args: [], cwd: null, unavailable: 'GV 微调在 T3 接入（走 GPT-SoVITS runtime）' }
    default:
      return { exe: '', args: [], cwd: null, unavailable: `未知任务类型：${String(req.kind)}` }
  }
}

export interface TrainProgress {
  percent: number
  stage: string
}

function stageOf(text: string): string {
  return text.length > 48 ? text.slice(0, 48) : text
}

/**
 * 已知训练日志格式 → 进度。命中不了返回 null（这种行只进日志环，不动进度条）。
 * 优先级：epoch a/b（分式算百分比）→ tqdm 进度条 → step a/b → 裸百分比。
 */
export function parseTrainProgress(line: string): TrainProgress | null {
  const text = line.trim()
  if (!text) return null
  const epoch = /epoch\s+(\d+)\s*\/\s*(\d+)/i.exec(text)
  if (epoch) {
    const total = Number(epoch[2])
    if (total <= 0) return null
    return { percent: Math.min(100, Math.floor((Number(epoch[1]) / total) * 100)), stage: `epoch ${epoch[1]}/${epoch[2]}` }
  }
  const tqdm = /(\d{1,3})%\s*\|/.exec(text)
  if (tqdm) return { percent: Math.min(100, Number(tqdm[1])), stage: stageOf(text) }
  const step = /step\s+(\d+)\s*\/\s*(\d+)/i.exec(text)
  if (step) {
    const total = Number(step[2])
    if (total <= 0) return null
    return { percent: Math.min(100, Math.floor((Number(step[1]) / total) * 100)), stage: `step ${step[1]}/${step[2]}` }
  }
  const bare = /\b(\d{1,3})\s*%/.exec(text)
  if (bare) return { percent: Math.min(100, Number(bare[1])), stage: stageOf(text) }
  return null
}
