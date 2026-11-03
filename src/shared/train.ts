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
  }
  /** gv-* 专用：窗口表单里的意图；主进程校验模板/底模/数据集后才转成 gvResolved。 */
  gv?: GvTrainOptions
  /** gv-* 专用：主进程写好训练配置后填（argv/cwd 全从这里来）；没填按环境没就绪拒启动。 */
  gvResolved?: GvResolvedPaths
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
        args: ['-s', gv.script, req.kind === 'gv-gpt' ? '--config_file' : '--config', gv.configFile],
        cwd: gv.home
      }
    }
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

// —— 录音判定（录音面板）：何时停、收不收、段叫什么 ——
/** 试点（G15，20 句）实测阈值；改任何一项之前先过 --train-probe，再真人试录一遍。 */
export const RECORDING_LIMITS = {
  rmsThreshold: 0.012,
  quietMsToStop: 1200,
  minMs: 400,
  maxMs: 20000,
} as const

/** 一次录音的步进状态：探没探到说话、静音武装起于何时、从何时起录。 */
export interface RecordingStepState {
  speechSeen: boolean
  quietSince: number // 0 = 静音还没武装：说完话后的第一块安静样本才起表
  startedAt: number
}

/** 开录那一刻的状态。 */
export function initialRecordingState(nowMs: number): RecordingStepState {
  return { speechSeen: false, quietSince: 0, startedAt: nowMs }
}

/**
 * 每块音频走一步：超阈值记「说过话」并解除静音武装；说完连静 quietMsToStop 自动停
 * （读稿节奏就是句间停一秒），maxMs 硬上限兜底。静音时限先判、上限后判，同一步都命中
 * 时 reason 归先判中的。只做决策，不碰 MediaStream——采样管线留在渲染端。
 */
export function advanceRecording(
  state: RecordingStepState,
  input: { rms: number; nowMs: number },
): { state: RecordingStepState; stop: boolean; reason: string | null } {
  const next: RecordingStepState = { ...state }
  let stop = false
  let reason: string | null = null
  if (input.rms >= RECORDING_LIMITS.rmsThreshold) {
    next.speechSeen = true
    next.quietSince = 0
  } else if (next.speechSeen) {
    if (!next.quietSince) next.quietSince = input.nowMs
    else if (input.nowMs - next.quietSince >= RECORDING_LIMITS.quietMsToStop) {
      stop = true
      reason = '自动停'
    }
  }
  if (!stop && input.nowMs - next.startedAt >= RECORDING_LIMITS.maxMs) {
    stop = true
    reason = `到 ${RECORDING_LIMITS.maxMs / 1000}s 上限`
  }
  return { state: next, stop, reason }
}

/**
 * 收尾判定：太短丢；全程没探到说话（哑麦/阈值漏探）的静音段也丢——静音配稿子是脏样本。
 * 时长判定在前，两条件同犯时报「太短」。
 */
export function shouldKeepTake({ durationMs, speechSeen }: { durationMs: number; speechSeen: boolean }): {
  keep: boolean
  reason: string | null
} {
  if (durationMs < RECORDING_LIMITS.minMs) return { keep: false, reason: `太短（${durationMs}ms），丢弃了——重新点录制` }
  if (!speechSeen) return { keep: false, reason: '没检测到说话，丢弃——重新点录制' }
  return { keep: true, reason: null }
}

/** 段序号键：逐句组 L+两位序号，自由说组 T+两位序号。 */
export function takeLineId(mode: 'lines' | 'free', no: number): string {
  return `${mode === 'free' ? 'T' : 'L'}${String(no).padStart(2, '0')}`
}

/** 完整录音键（Gxx-Lnn / Gxx-Tnn）：渲染端查表用；主进程 safeKeys 独立校验同一形状。 */
export function recordingKey(groupId: string, mode: 'lines' | 'free', no: number): string {
  return `${groupId}-${takeLineId(mode, no)}`
}

// —— GV（GPT-SoVITS）微调（T3）：版本映射、备料验收与训练配置拼装的纯缝 ——

export type GvVersion = 'v1' | 'v2' | 'v3' | 'v4' | 'v2Pro' | 'v2ProPlus'

/** 引擎包默认 v2ProPlus（v2pro 分发包就是这套底模），下拉也把它排最前。 */
export const GV_VERSION_DEFAULT: GvVersion = 'v2ProPlus'

/** 一张版本的全部引擎包内相对路径；照抄上游 config.py / webui.py 的映射，别自创。 */
export interface GvVersionInfo {
  /** s2 训练读的配置模板（v2Pro/v2ProPlus 有专属模板，其余共用 s2.json）。 */
  s2ConfigTemplate: string
  s2PretrainedG: string
  s2PretrainedD: string
  /** s1 训练读的 yaml 模板（v1 用 s1longer.yaml，其余全是 s1longer-v2.yaml）。 */
  s1ConfigTemplate: string
  s1Pretrained: string
  /** 训练产物落点（上游「版本 → 权重目录」映射），注册音色包时按这里找最新产物。 */
  sovitsWeightsRoot: string
  gptWeightsRoot: string
}

const PRE = 'GPT_SoVITS/pretrained_models'

export const GV_VERSION_INFO: Record<GvVersion, GvVersionInfo> = {
  v1: {
    s2ConfigTemplate: 'GPT_SoVITS/configs/s2.json',
    s2PretrainedG: `${PRE}/s2G488k.pth`,
    s2PretrainedD: `${PRE}/s2D488k.pth`,
    s1ConfigTemplate: 'GPT_SoVITS/configs/s1longer.yaml',
    s1Pretrained: `${PRE}/s1bert25hz-2kh-longer-epoch=68e-step=50232.ckpt`,
    sovitsWeightsRoot: 'SoVITS_weights',
    gptWeightsRoot: 'GPT_weights'
  },
  v2: {
    s2ConfigTemplate: 'GPT_SoVITS/configs/s2.json',
    s2PretrainedG: `${PRE}/gsv-v2final-pretrained/s2G2333k.pth`,
    s2PretrainedD: `${PRE}/gsv-v2final-pretrained/s2D2333k.pth`,
    s1ConfigTemplate: 'GPT_SoVITS/configs/s1longer-v2.yaml',
    s1Pretrained: `${PRE}/gsv-v2final-pretrained/s1bert25hz-5kh-longer-epoch=12-step=369668.ckpt`,
    sovitsWeightsRoot: 'SoVITS_weights_v2',
    gptWeightsRoot: 'GPT_weights_v2'
  },
  v3: {
    s2ConfigTemplate: 'GPT_SoVITS/configs/s2.json',
    s2PretrainedG: `${PRE}/s2Gv3.pth`,
    s2PretrainedD: `${PRE}/s2Dv3.pth`,
    s1ConfigTemplate: 'GPT_SoVITS/configs/s1longer-v2.yaml',
    s1Pretrained: `${PRE}/s1v3.ckpt`,
    sovitsWeightsRoot: 'SoVITS_weights_v3',
    gptWeightsRoot: 'GPT_weights_v3'
  },
  v4: {
    s2ConfigTemplate: 'GPT_SoVITS/configs/s2.json',
    s2PretrainedG: `${PRE}/gsv-v4-pretrained/s2Gv4.pth`,
    s2PretrainedD: `${PRE}/gsv-v4-pretrained/s2Dv4.pth`,
    s1ConfigTemplate: 'GPT_SoVITS/configs/s1longer-v2.yaml',
    s1Pretrained: `${PRE}/s1v3.ckpt`,
    sovitsWeightsRoot: 'SoVITS_weights_v4',
    gptWeightsRoot: 'GPT_weights_v4'
  },
  v2Pro: {
    s2ConfigTemplate: 'GPT_SoVITS/configs/s2v2Pro.json',
    s2PretrainedG: `${PRE}/v2Pro/s2Gv2Pro.pth`,
    s2PretrainedD: `${PRE}/v2Pro/s2Dv2Pro.pth`,
    s1ConfigTemplate: 'GPT_SoVITS/configs/s1longer-v2.yaml',
    s1Pretrained: `${PRE}/s1v3.ckpt`,
    sovitsWeightsRoot: 'SoVITS_weights_v2Pro',
    gptWeightsRoot: 'GPT_weights_v2Pro'
  },
  v2ProPlus: {
    s2ConfigTemplate: 'GPT_SoVITS/configs/s2v2ProPlus.json',
    s2PretrainedG: `${PRE}/v2Pro/s2Gv2ProPlus.pth`,
    s2PretrainedD: `${PRE}/v2Pro/s2Dv2ProPlus.pth`,
    s1ConfigTemplate: 'GPT_SoVITS/configs/s1longer-v2.yaml',
    s1Pretrained: `${PRE}/s1v3.ckpt`,
    sovitsWeightsRoot: 'SoVITS_weights_v2ProPlus',
    gptWeightsRoot: 'GPT_weights_v2ProPlus'
  }
}

export function normalizeGvVersion(value: unknown): GvVersion {
  return typeof value === 'string' && value in GV_VERSION_INFO ? (value as GvVersion) : GV_VERSION_DEFAULT
}

/** 窗口表单意图：版本 + 批大小 + 轮数（默认照抄 webui 的保守值）。 */
export interface GvTrainOptions {
  version: GvVersion
  batchSize: number
  epochs: number
}

export const GV_DEFAULTS: Record<'gv-sovits' | 'gv-gpt', { batchSize: number; epochs: number }> = {
  'gv-sovits': { batchSize: 8, epochs: 8 },
  'gv-gpt': { batchSize: 8, epochs: 15 }
}

/** 主进程备好配置文件后回填；deriveTrainPlan 的 argv/cwd 全从这里来。 */
export interface GvResolvedPaths {
  home: string
  pythonExe: string
  /** 写好的训练配置（tmp_s2.json / tmp_s1.yaml 绝对路径）。 */
  configFile: string
  /** 引擎包内训练脚本相对路径（GPT_SoVITS/s2_train.py 或 s1_train.py）。 */
  script: string
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export interface GvDatasetPresence {
  expName: string
  phonemes: boolean
  semantic: boolean
  hubert: boolean
  wav32k: boolean
}

export interface GvDatasetJudgement {
  expName: string
  ready: boolean
  missing: string[]
}

/** 备料齐全 = webui 三步（1abc）留下的四件套都在；打标注/降噪仍走 webui，这里只验收。 */
export function judgeGvDataset(p: GvDatasetPresence): GvDatasetJudgement {
  const checks: Array<[string, boolean]> = [
    ['音素表 2-name2text.txt', p.phonemes],
    ['语义表 6-name2semantic.tsv', p.semantic],
    ['Hubert 特征 4-cnhubert/', p.hubert],
    ['32k 音频 5-wav32k/', p.wav32k]
  ]
  return {
    expName: p.expName,
    ready: checks.every(([, ok]) => ok),
    missing: checks.filter(([, ok]) => !ok).map(([name]) => name)
  }
}

/** 把 s2 模板改成本次训练配置；返回 null 说明模板缺关键节点（引擎包不完整，别硬写）。参数照抄 webui open1Ba。 */
export function buildS2TrainConfigData(
  base: unknown,
  opts: { train: GvTrainOptions; expName: string; pretrainedG: string; pretrainedD: string; sovitsWeightsRoot: string }
): Record<string, unknown> | null {
  if (!isRecord(base) || !isRecord(base.train) || !isRecord(base.data) || !isRecord(base.model)) return null
  const expDir = `logs/${opts.expName}`
  return {
    ...base,
    train: {
      ...base.train,
      batch_size: opts.train.batchSize,
      epochs: opts.train.epochs,
      text_low_lr_rate: 0.4,
      pretrained_s2G: opts.pretrainedG,
      pretrained_s2D: opts.pretrainedD,
      if_save_latest: true,
      if_save_every_weights: true,
      save_every_epoch: opts.train.epochs,
      gpu_numbers: '0',
      grad_ckpt: false,
      lora_rank: 32
    },
    model: { ...base.model, version: opts.train.version },
    data: { ...base.data, exp_dir: expDir },
    s2_ckpt_dir: expDir,
    save_weight_dir: opts.sovitsWeightsRoot,
    name: opts.expName,
    version: opts.train.version
  }
}

/** 把 s1 yaml 模板改成本次训练配置；语义/音素/输出三路径与 DPO 开关照抄 webui open1Bb（GPU 机器 precision 保持 16-mixed）。 */
export function buildS1TrainConfigData(
  base: unknown,
  opts: { train: GvTrainOptions; expName: string; pretrainedS1: string; gptWeightsRoot: string }
): Record<string, unknown> | null {
  if (!isRecord(base) || !isRecord(base.train)) return null
  return {
    ...base,
    train: {
      ...base.train,
      batch_size: opts.train.batchSize,
      epochs: opts.train.epochs,
      save_every_n_epoch: opts.train.epochs,
      if_save_every_weights: true,
      if_save_latest: true,
      if_dpo: true,
      half_weights_save_dir: opts.gptWeightsRoot,
      exp_name: opts.expName
    },
    pretrained_s1: opts.pretrainedS1,
    train_semantic_path: `logs/${opts.expName}/6-name2semantic.tsv`,
    train_phoneme_path: `logs/${opts.expName}/2-name2text.txt`,
    output_dir: `logs/${opts.expName}/logs_s1_${opts.train.version}`
  }
}

/** 产物登记请求/结果：训练窗口「注册为音色包」的表单与主进程回执。 */
export interface GvRegisterPayload {
  expName: string
  version: string
  /** 音色显示名（也是权重/参考音频的落盘目录名）。 */
  name: string
}

export interface GvRegisterResult {
  ok: boolean
  error?: string
  entry?: Record<string, unknown>
}
