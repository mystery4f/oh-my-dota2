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
  /** asr-ft 专用：主进程检测环境 + 打包数据后填进来；没填就按「环境没就绪」拒启动。 */
  asrFt?: {
    paths: AsrFtPaths
    data: AsrFtDatasetPlan
    /** 导出产物目录（训练成功后链式导出写这里，应用新模型从这里拷）。 */
    exportDir: string
  }
}


/** ASR 微调环境里跑真训练/导出要用的几条路径（检测服务负责填，纯缝只拼命令）。 */
export interface AsrFtPaths {
  pythonExe: string
  sftScript: string
  exportScript: string
  baseModelDir: string
}

/** 一次 ASR 微调要吃的三样东西：打包产物和这次的输出目录。 */
export interface AsrFtDatasetPlan {
  trainJsonl: string
  evalJsonl: string
  runDir: string
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
      return { exe: asr.paths.pythonExe, args: planAsrFtTrainArgv(asr.paths, asr.data), cwd: null }
    }
    case 'gv-gpt':
    case 'gv-sovits':
      return { exe: '', args: [], cwd: null, unavailable: 'GV 微调在 T3 接入（走 GPT-SoVITS runtime）' }
    default:
      return { exe: '', args: [], cwd: null, unavailable: `未知任务类型：${String(req.kind)}` }
  }
}

// —— ASR 微调（T5）：训练/导出命令与换模决策的纯缝 ——

/** 训练参数：试点（G15，20 句）实测收敛的 v5 版本，参数冻结勿随手改。 */
export function planAsrFtTrainArgv(paths: AsrFtPaths, data: AsrFtDatasetPlan): string[] {
  return [
    paths.sftScript,
    '--model_path', paths.baseModelDir,
    '--train_file', data.trainJsonl,
    '--eval_file', data.evalJsonl,
    '--output_dir', data.runDir,
    '--batch_size', '1',
    '--grad_acc', '4',
    '--lr', '2e-5',
    '--epochs', '66',
    '--save_steps', '150',
    '--save_total_limit', '3',
    '--num_workers', '0',
    '--pin_memory', '0',
    '--persistent_workers', '0',
    '--log_steps', '5'
  ]
}

/** 导出参数：CPU 上量化 int8 并自校验，不占 GPU。 */
export function planAsrFtExportArgv(paths: AsrFtPaths, checkpointDir: string, exportDir: string): string[] {
  return [
    paths.exportScript,
    '--model', checkpointDir,
    '--outdir', exportDir,
    '--device', 'cpu',
    '--max-total-len', '512',
    '--verify'
  ]
}

/** checkpoint-N 目录名里挑编号最大的一个（没有就 null）。 */
export function pickLastCheckpointName(names: readonly string[]): string | null {
  let best: string | null = null
  let bestNo = -1
  for (const name of names) {
    const m = /^checkpoint-(\d+)$/.exec(name)
    const no = m ? Number(m[1]) : -1
    if (no > bestNo) {
      bestNo = no
      best = name
    }
  }
  return best
}

export type AsrFtSwapOp = 'rm-bak' | 'bak-active' | 'promote-next' | 'rm-active' | 'restore-bak'

/** 应用新模型的动作序列：旧备份先删，现役挪去备份，next 转正。next 不在 = 空序列（调用方报错）。 */
export function asrFtSwapSteps(state: { activeExists: boolean; bakExists: boolean; nextExists: boolean }): AsrFtSwapOp[] {
  if (!state.nextExists) return []
  const steps: AsrFtSwapOp[] = []
  if (state.bakExists) steps.push('rm-bak')
  if (state.activeExists) steps.push('bak-active')
  steps.push('promote-next')
  return steps
}

/** 回滚动作序列：现役删掉、备份归位。没有备份 = 空序列。 */
export function asrFtRollbackSteps(state: { bakExists: boolean }): AsrFtSwapOp[] {
  if (!state.bakExists) return []
  return ['rm-active', 'restore-bak']
}

/** 窗口要的微调环境 + 换模状态（检测服务填，这里只定形状）。 */
export interface AsrFtStatusResult {
  env: { ok: boolean; gaps: string[]; envRoot: string }
  swap: { activeExists: boolean; bakExists: boolean; nextExists: boolean; lastExportDir: string | null }
  /** 一键安装的即时状态：null = 这次会话还没跑过安装。 */
  install: AsrFtInstallState | null
}

/** M-B 一键安装的进行时状态：窗口轮询这块渲染进度。 */
export interface AsrFtInstallState {
  running: boolean
  stage: string
  progress: number
  error: string | null
}

/** 换模/回滚动作的结果：失败带人话原因。 */
export interface AsrFtSwapResult {
  ok: boolean
  error: string | null
}

/** 环境缺什么：四条路径逐项点名，全齐 = 空数组。 */
export function deriveAsrFtEnvGaps(paths: Partial<AsrFtPaths> & { venvOk?: boolean }): string[] {
  const gaps: string[] = []
  if (!paths.venvOk) gaps.push('Python 虚拟环境（venv/Scripts/python.exe，装 torch 等训练依赖）')
  if (!paths.sftScript) gaps.push('官方微调脚本（sft/qwen3_asr_sft.py）')
  if (!paths.exportScript) gaps.push('ONNX 导出脚本（export/export_qwen3_asr_onnx.py）')
  if (!paths.baseModelDir) gaps.push('底模（models/Qwen3-ASR-0.6B，约 1.2GB）')
  return gaps
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

/** 打包给训练脚本的一条数据：录音绝对路径 + 稿子原文。 */
export interface FtDatasetEntry {
  wavPath: string
  text: string
}

/** 一键准备结果：两份 JSONL 的条数与落盘路径（error 非空时其余无意义）。 */
export interface FtDatasetPrepareResult {
  ok: boolean
  trainCount: number
  evalCount: number
  trainPath: string
  evalPath: string
  error: string | null
}

/** 读稿组/句最小视图（免得共享类型互相循环依赖）。 */
export interface FtDatasetGroupView {
  id: string
  mode: 'lines' | 'free'
  lines: Array<{ no: number; text: string }>
}

/**
 * 录音 × 稿子 → 训练条目。逐句组只收已录的；自由说组没有标准答案，监督训练用不了，整组跳过。
 * hasRec/wavPath 由调用方注入（主进程给磁盘真值，探针给假值），这里不做任何 IO。
 */
export function buildFtDatasetEntries(
  groups: FtDatasetGroupView[],
  hasRec: (group: string, line: string) => boolean,
  wavPath: (group: string, line: string) => string,
): { entries: FtDatasetEntry[]; notRecorded: number } {
  const entries: FtDatasetEntry[] = []
  let notRecorded = 0
  for (const group of groups) {
    if (group.mode === 'free') continue
    for (const line of group.lines) {
      const key = `L${String(line.no).padStart(2, '0')}`
      if (!hasRec(group.id, key)) {
        notRecorded += 1
        continue
      }
      entries.push({ wavPath: wavPath(group.id, key), text: line.text })
    }
  }
  return { entries, notRecorded }
}

/**
 * 训练/验证切分：尾部 holdout 条进验证集（录音天然按组序落盘，尾部=最晚录的）；
 * 数据太少（≤2×holdout）就全给训练，验证集留空——试点别为切分浪费数据。
 */
export function splitTrainEval(
  entries: FtDatasetEntry[],
  holdout = 2,
): { train: FtDatasetEntry[]; eval: FtDatasetEntry[] } {
  if (entries.length <= holdout * 2) return { train: entries.slice(), eval: [] }
  return { train: entries.slice(0, entries.length - holdout), eval: entries.slice(entries.length - holdout) }
}

/** 官方 qwen3_asr_sft.py 要的 JSONL 行：中文固定带 language 前缀（实测格式）。 */
export function buildFtJsonlLine(entry: FtDatasetEntry): string {
  return JSON.stringify({ audio: entry.wavPath, text: `language Chinese<asr_text>${entry.text}` })
}

export function buildFtJsonlText(entries: FtDatasetEntry[]): string {
  if (entries.length === 0) return ''
  return `${entries.map((entry) => buildFtJsonlLine(entry)).join('\n')}\n`
}
