/** ASR 微调（T5）纯缝：训练/导出命令拼装、checkpoint 挑选、换模/回滚步骤、环境缺口点名。 */
import { ASR_ENGINES, type AsrEngineId } from '../asr/engines'

/** 训练入口的形状：qwen3 用官方 sft 脚本 + 本地底模目录；funasr 用 `python -m funasr.bin.train` + hub 模型 id。 */
export type AsrFtTrainer = 'qwen3-sft' | 'funasr-paraformer'

/** ASR 微调环境里跑真训练/导出要用的几条路径（检测服务负责填，纯缝只拼命令）。 */
export interface AsrFtPaths {
  trainer: AsrFtTrainer
  pythonExe: string
  /** qwen3 布局：官方微调脚本；funasr 走模块，留空。 */
  sftScript: string
  exportScript: string
  baseModelDir: string
  /** funasr 布局：hub 模型 id（`++model=`）；qwen3 用本地底模目录，留空。 */
  baseModelId: string
}

/** 这个 trainer 支不支持在上一版上续训。funasr 的续训只认自己 output_dir 里的 checkpoint，跨 run 目录接不上。 */
export function trainerCanResume(trainer: AsrFtTrainer): boolean {
  return trainer === 'qwen3-sft'
}

/** 一次 ASR 微调要吃的三样东西：打包产物和这次的输出目录。 */
export interface AsrFtDatasetPlan {
  trainJsonl: string
  evalJsonl: string
  runDir: string
}
/** 目标总步数≈800：G14 实测 38 条 × 66 轮 = 660 步 ≈ 65 分钟，步数与数据量线性；轮数按数据量自适应，封顶 66、保底 10。 */
export const FT_TARGET_STEPS = 800
/** 每步吃 4 条（batch_size 1 × grad_acc 4）；deriveFtEpochs 用它折算每轮步数。 */
export const FT_SAMPLES_PER_STEP = 4

/** 自适应轮数：步/轮 = ceil(训练条数/4)，轮 = clamp(round(目标步数/步每轮), 10, 66)。数据为 0 回 66（不会发生，防御）。 */
export function deriveFtEpochs(trainCount: number): number {
  if (trainCount <= 0) return 66
  const stepsPerEpoch = Math.max(1, Math.ceil(trainCount / FT_SAMPLES_PER_STEP))
  return Math.min(66, Math.max(10, Math.round(FT_TARGET_STEPS / stepsPerEpoch)))
}

/** funasr 每步只吃 1 条（batch_size 1，不折步），目标定 600 步：40 条数据下约 15 轮。 */
export const FT_FUNASR_TARGET_STEPS = 600

/** 按 trainer 折算轮数：qwen3 走上面那套（一步 4 条），funasr 一步 1 条。 */
export function deriveFtEpochsFor(trainer: AsrFtTrainer, trainCount: number): number {
  if (trainer !== 'funasr-paraformer') return deriveFtEpochs(trainCount)
  if (trainCount <= 0) return 20
  return Math.min(40, Math.max(4, Math.round(FT_FUNASR_TARGET_STEPS / trainCount)))
}

/** 增量起点：上一个 run 留下的 pytorch 权重（导出产物只有 int8 onnx，接不上）。优先平均权重。 */
export function incrementalWeightFile(names: readonly string[]): string | null {
  return ['model.pt.avg1', 'model.pt.best', 'model.pt'].find((name) => names.includes(name)) ?? null
}

/** 增量微调的目标步数：只纠当前这批错，步数比从底模训少一半多。 */
export const FT_INCREMENTAL_TARGET_STEPS = 300

/** 增量轮数：目标 ≈300 步，clamp 2–12；数据为 0 回 4（防御，实际到不了）。 */
export function deriveFtIncrementalEpochs(trainCount: number): number {
  if (trainCount <= 0) return 4
  return Math.min(12, Math.max(2, Math.round(FT_INCREMENTAL_TARGET_STEPS / trainCount)))
}

/** 开训口径：两条腿的轮数与学习率**只能**从这里出，别在调用点各拼一套。 */
export type AsrFtMode = 'fresh' | 'incremental'

export function planFtTuning(input: {
  mode: AsrFtMode
  trainer: AsrFtTrainer
  trainCount: number
  lastStep?: number
  resumeFrom?: string | null
  initFrom?: string | null
}): AsrFtTrainTuning {
  const { mode, trainer, trainCount } = input
  if (mode !== 'incremental') return { epochs: deriveFtEpochsFor(trainer, trainCount), lr: ftDefaultLr(trainer) }
  if (trainer === 'funasr-paraformer') {
    // funasr 的续训只认自己 output_dir 里的 checkpoint，所以增量的接法是 init_param 指旧权重。
    return { epochs: deriveFtIncrementalEpochs(trainCount), lr: '1e-5', initFrom: input.initFrom ?? undefined }
  }
  return { epochs: deriveFtResumeEpochs(trainCount, input.lastStep ?? 0), lr: '1e-5', resumeFrom: input.resumeFrom ?? undefined }
}

/** 默认学习率：qwen3 微调实测用 2e-5；funasr 官方 finetune.sh 给 2e-4。 */
export function ftDefaultLr(trainer: AsrFtTrainer): string {
  return trainer === 'funasr-paraformer' ? '0.0002' : '2e-5'
}

/** 续训每轮步数（batch 1 × grad_acc 4）。 */
function ftStepsPerEpoch(trainCount: number): number {
  return Math.max(1, Math.ceil(trainCount / FT_SAMPLES_PER_STEP))
}

/** 续训在旧 checkpoint 之上固定补训的步数（4060 实测 3.6s/步 ≈ 12 分钟）。 */
export const FT_RESUME_EXTRA_STEPS = 200

/**
 * 续训轮数：HF Trainer 拿 resume_from_checkpoint 恢复 global_step，max_steps（轮数×步/轮）一旦
 * 不大于已到的步数就整轮直接跳过（一行日志都没有）。所以轮数必须保证
 * 总步数 > 上次 checkpoint 步数，这里固定再补 200 步（4060 实测约 12 分钟）再按新数据量折算。
 */
export function deriveFtResumeEpochs(trainCount: number, lastStep: number): number {
  return Math.ceil((lastStep + FT_RESUME_EXTRA_STEPS) / ftStepsPerEpoch(trainCount))
}

/** 训练超参覆盖：不传 = 冻结的试点参数（lr 2e-5、66 轮、不续训）。 */
export interface AsrFtTrainTuning {
  epochs?: number
  lr?: string
  /** 续训的 checkpoint 目录绝对路径；给了就拼 --resume_from，导出挑的就是它的下一个编号。 */
  resumeFrom?: string
  /** funasr 的增量起点：上一个 run 留下的 pytorch 权重文件（导出产物是 int8 onnx，接不了）。 */
  initFrom?: string
}
/** 训练参数：试点（G15，20 句）实测收敛的 v5 版本为默认，轮数/lr/续训点可按 tuning 覆盖。 */
export function planAsrFtTrainArgv(paths: AsrFtPaths, data: AsrFtDatasetPlan, tuning?: AsrFtTrainTuning): string[] {
  if (paths.trainer === 'funasr-paraformer') return planFunasrTrainArgv(paths, data, tuning)
  return [
    paths.sftScript,
    '--model_path', paths.baseModelDir,
    '--train_file', data.trainJsonl,
    '--eval_file', data.evalJsonl,
    '--output_dir', data.runDir,
    '--batch_size', '1',
    '--grad_acc', '4',
    '--lr', tuning?.lr ?? '2e-5',
    '--epochs', String(tuning?.epochs ?? 66),
    ...(tuning?.resumeFrom ? ['--resume_from', tuning.resumeFrom] : []),
    '--save_steps', '150',
    '--save_total_limit', '3',
    '--num_workers', '0',
    '--pin_memory', '0',
    '--persistent_workers', '0',
    '--log_steps', '5'
  ]
}

/**
 * FunASR 训练 argv（hydra 风格 `++k=v`，与官方 finetune.sh 同参数名）。
 * 与官方脚本的差别只有三处，都是为了本机的 40 条小数据和 CPU：
 * batch_size 1（官方按 6000 token 一档）、num_workers 0（Windows 子进程不稳）、不跑 deepspeed。
 */
function planFunasrTrainArgv(paths: AsrFtPaths, data: AsrFtDatasetPlan, tuning?: AsrFtTrainTuning): string[] {
  return [
    '-m', 'funasr.bin.train',
    `++model=${paths.baseModelId}`,
    ...(tuning?.initFrom ? [`++init_param=${tuning.initFrom}`] : []),
    `++train_data_set_list=${data.trainJsonl}`,
    `++valid_data_set_list=${data.evalJsonl}`,
    '++dataset=AudioDataset',
    '++dataset_conf.index_ds=IndexDSJsonl',
    '++dataset_conf.data_split_num=1',
    '++dataset_conf.batch_sampler=BatchSampler',
    '++dataset_conf.batch_size=1',
    '++dataset_conf.batch_type=example',
    '++dataset_conf.sort_size=1024',
    '++dataset_conf.num_workers=0',
    `++train_conf.max_epoch=${tuning?.epochs ?? 20}`,
    '++train_conf.log_interval=1',
    '++train_conf.resume=false',
    // 校验间隔必须**等于**存盘间隔，且两者都得小于总步数：trainer 的两处坑都是这么踩的——
    // ① save_checkpoint 无条件读 val_acc[ckpt_name]，校验没跑过就是 KeyError（实测 'model.pt.ep0.20'）；
    // ② 收尾 average_checkpoints 按 val 表取文件名再开文件，校验比存盘密时会选中「有记录没文件」的名字
    //    （实测选中 model.pt.ep0.10），于是 RuntimeError: No checkpoints found for averaging。
    '++train_conf.validate_interval=20',
    '++train_conf.save_checkpoint_interval=20',
    // 至少留 2 个：平均权重那步是按 val 表取前 avg_nbest_model 个文件名再开文件，
    // keep_nbest_models=1 会把那个文件先删掉，收尾直接 RuntimeError: No checkpoints（实测 2026-11-08）。
    '++train_conf.keep_nbest_models=2',
    '++train_conf.avg_nbest_model=1',
    '++train_conf.use_deepspeed=false',
    `++optim_conf.lr=${tuning?.lr ?? '0.0002'}`,
    `++output_dir=${data.runDir}`
  ]
}
/**
 * 导出参数。
 * - funasr：走打包的 `asr-ft-export-funasr.py`，它把「导出 → 量化 → 补 tokens/metadata」一步做完。
 *   `--base` 必须是底模 id（或底模目录），不能是 run 目录——AutoModel 会把 run 目录里的训练配置
 *   当模型配置读，导出半初始化的图（实测 955 个 initializer 只剩 625 个，输出全是乱码）。
 * - qwen3：调用训练腿自带的 export 脚本。
 */
export function planAsrFtExportArgv(
  paths: AsrFtPaths,
  checkpointDir: string,
  exportDir: string,
  exportTool = '',
  // funasr：权重文件名，调用方按「avg1 → best → 最后一轮」挑；别的 trainer 用不到。
  weightsFile = 'model.pt'
): string[] {
  if (paths.trainer === 'funasr-paraformer') {
    const base = paths.baseModelId || paths.baseModelDir
    if (exportTool) {
      return [exportTool, '--base', base, '--init-param', `${checkpointDir}/${weightsFile}`, '--output-dir', exportDir]
    }
    return [
      '-m', 'funasr.bin.export',
      `++model=${base}`,
      // init_param 必须是权重文件：AutoModel 只判 os.path.exists，目录会送进 torch.load 直接炸。
      `++init_param=${checkpointDir}/${weightsFile}`,
      `++output_dir=${exportDir}`,
      '++type=onnx',
      '++quantize=true',
      '++device=cpu'
    ]
  }
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

/**
 * 应用新模型的动作序列：旧备份先删，现役挪去备份，next 转正。
 * 触发条件看「有没有东西可转正」——导出产物在（正常路径，promote-next 自己把它拷成 next），
 * 或者上次换模被中断留下的 next 还在；两样都没有才是空序列。
 * 只认 next 会让「导出成功、点按钮」这条主路径永远返回空序列（曾经的 bug）。
 */
export function asrFtSwapSteps(state: {
  activeExists: boolean
  bakExists: boolean
  nextExists: boolean
  exportExists: boolean
}): AsrFtSwapOp[] {
  if (!state.nextExists && !state.exportExists) return []
  const steps: AsrFtSwapOp[] = []
  if (state.bakExists) steps.push('rm-bak')
  if (state.activeExists) steps.push('bak-active')
  steps.push('promote-next')
  return steps
}
/** sherpa 真正加载的三件 int8 文件：导出目录里除此之外还躺着 3–5 GB 的 fp32 外置数据。 */
/** 某个引擎转正后的模型目录里必须有哪几件（sherpa 加载清单，来自引擎表）。 */
export function ftArtifactTargets(engineId: AsrEngineId = 'qwen3'): string[] {
  return (ASR_ENGINES[engineId].finetune?.artifacts ?? []).map((item) => item.to)
}

/** 换模槽位里缺哪几件：按表里声明的落位文件名查（qwen3 三个 onnx，paraformer 的 int8 + tokens）。 */
export function missingFtSlotFiles(names: readonly string[], engineId: AsrEngineId = 'qwen3'): string[] {
  return ftArtifactTargets(engineId).filter((name) => !names.includes(name))
}

/** sherpa 真正加载的几件文件：导出目录里除此之外还躺着 3–5 GB 的 fp32 外置数据。 */
export const FT_MODEL_FILES: readonly string[] = ftArtifactTargets('qwen3')

/**
 * 导出产物齐全判据：缺的是**导出目录里应该出现的那几个源文件**（`artifacts[].from`）。
 * 训练腿跑完而导出腿还在写最后一件时，目录里已经有别的文件了——
 * 那时点「应用新模型」会把残缺目录转正，识别直接加载失败，所以必须逐件点名。
 */
export function missingFtExportFiles(names: readonly string[], engineId: AsrEngineId = 'qwen3'): string[] {
  const sources = (ASR_ENGINES[engineId].finetune?.artifacts ?? []).map((item) => item.from)
  return sources.filter((name) => !names.includes(name))
}

/** 回滚动作序列：现役删掉、备份归位。没有备份 = 空序列。 */
export function asrFtRollbackSteps(state: { bakExists: boolean }): AsrFtSwapOp[] {
  if (!state.bakExists) return []
  return ['rm-active', 'restore-bak']
}

/** 窗口要的微调环境 + 换模状态（检测服务填，这里只定形状）。 */
export interface AsrFtStatusResult {
  env: { ok: boolean; gaps: string[]; envRoot: string }
  /** 这次训练落在哪个引擎上：面板必须能说清「训的是谁」，不然用户只能猜。 */
  target: { engineId: string; label: string; trainer: AsrFtTrainer; modelDir: string; baseModel: string }
  swap: { activeExists: boolean; bakExists: boolean; nextExists: boolean; lastExportDir: string | null }
  /** 已训标记：最近一次微调的账本 vs 当前录音，按组算 done/total/stale（key = 组 id）。 */
  coverage: Record<string, FtCoverageGroup>
  /** 一键安装的即时状态：null = 这次会话还没跑过安装。 */
  install: AsrFtInstallState | null
}

/** 开训闸门看到的两件事实：显存提示，以及上一份账本是否真的能续训。panel 只显示，不自己推。 */
export interface AsrFtFacts {
  /** 非空就是一条件显存告警；查不到 nvidia-smi 时是 null。 */
  vramNote: string | null
  /** 与开训闸门同一判据：最新账本对得上且还留着 checkpoint。 */
  resumable: boolean
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
  /** 转正时用的那次导出（run id）；回滚与失败为空。 */
  model?: string | null
}

/** 换模结果的用户可见文案：带上转正的是哪一次导出，免得以为换的是刚训完那版。 */
export function ftAppliedNote(result: AsrFtSwapResult): string {
  if (!result.ok) return result.error ?? '应用失败'
  return result.model ? `新模型已转正（${result.model}），下一句识别就用它` : '新模型已转正，下一句识别就用它'
}

/** 环境缺什么：四条路径逐项点名，全齐 = 空数组。 */
export function deriveAsrFtEnvGaps(paths: Partial<AsrFtPaths> & { venvOk?: boolean }): string[] {
  const gaps: string[] = []
  if (!paths.venvOk) gaps.push('Python 虚拟环境（venv/Scripts/python.exe，装 torch 等训练依赖）')
  if (paths.trainer === 'funasr-paraformer') {
    // funasr 的底模与训练配置由它自己从 ModelScope 拉，本机只需能连上；缺包由异步体检补上来。
    if (!paths.baseModelId) gaps.push('训练底模 id（引擎表里的 hub 模型，缺了没法起训）')
    return gaps
  }
  if (!paths.sftScript) gaps.push('官方微调脚本（sft/qwen3_asr_sft.py）')
  if (!paths.exportScript) gaps.push('ONNX 导出脚本（export/export_qwen3_asr_onnx.py）')
  if (!paths.baseModelDir) gaps.push('底模（models/Qwen3-ASR-0.6B，约 1.2GB）')
  return gaps
}

/** 账本一行：训练吃过的每条录音的磁盘指纹（key = recordingKey 产物，如 G14-L03）。 */
export interface FtLedgerEntry {
  key: string
  wavPath: string
  bytes: number
  mtimeMs: number
  text: string
  split: 'train' | 'eval'
}

/** run.json 的形状：一次微调从开跑到转正的状态流水。 */
export interface FtRunMeta {
  runId: string
  startedAt: number
  epochs: number
  lr: string
  resumeFrom: string | null
  status: 'running' | 'trained' | 'applied' | 'failed'
  finishedAt: number | null
  exportDir: string
  applied: boolean
}

export interface FtCoverageGroup {
  done: number
  total: number
  stale: number
}

/**
 * 已训标记：最近一次训过的账本 vs 磁盘现状，按组算 done/total/stale。
 * key+bytes+mtimeMs 全等 = 训过；同 key 但文件变过 = stale（重录了，得再训）；账本没有 = 没训过。
 * free 组（Txx）没有标准答案从不进训，UI 自行按组模式过滤。
 */
export function ftTrainCoverage(
  manifest: readonly FtLedgerEntry[],
  current: readonly { key: string; bytes: number; mtimeMs: number }[]
): Record<string, FtCoverageGroup> {
  const trained = new Map(manifest.map((e) => [e.key, e]))
  const out: Record<string, FtCoverageGroup> = {}
  for (const rec of current) {
    const group = rec.key.split('-')[0] ?? rec.key
    const g = out[group] ?? { done: 0, total: 0, stale: 0 }
    g.total += 1
    const m = trained.get(rec.key)
    if (m) {
      if (m.bytes === rec.bytes && m.mtimeMs === rec.mtimeMs) g.done += 1
      else g.stale += 1
    }
    out[group] = g
  }
  return out
}

/** 续训资格：上一次账本的每条在现状里 key+bytes+mtimeMs 全等（数据只增不改）；空账本一律 false。 */
export function ftLedgerMatchedOnDisk(
  past: readonly FtLedgerEntry[],
  current: readonly { key: string; bytes: number; mtimeMs: number }[]
): boolean {
  if (past.length === 0) return false
  const now = new Map(current.map((c) => [c.key, `${c.bytes}|${c.mtimeMs}`]))
  return past.every((e) => now.get(e.key) === `${e.bytes}|${e.mtimeMs}`)
}

/** 8G 卡实测训练净占 ~6.2G（峰值 7661 − 空闲基线 1488）+ 200 MiB 余量。这是「建议线」，不是硬闸。 */
export const FT_TRAIN_NEED_MIB = 6400

export interface FtGpuApp {
  pid: number
  name: string
  usedMiB: number
}

/** nvidia-smi --query-compute-apps=pid,process_name,used_memory 的 csv 行（进程名可能含逗号：首逗号前 pid、末逗号后显存、中间是名字）。 */
export function parseNvidiaComputeApps(text: string): FtGpuApp[] {
  const out: FtGpuApp[] = []
  for (const line of text.split(/\r?\n/)) {
    const first = line.indexOf(',')
    const last = line.lastIndexOf(',')
    if (first < 0 || last <= first) continue
    const pid = Number(line.slice(0, first).trim())
    const usedMiB = Number(line.slice(last + 1).trim())
    if (!Number.isFinite(pid) || !Number.isFinite(usedMiB)) continue
    out.push({ pid, name: line.slice(first + 1, last).trim(), usedMiB })
  }
  return out
}

/** 显存账：可用 = 总 − (已用 − 自家将暂停的占用)。excludePids 是应用托管 GV（训练前会被 pause 让显存）。 */
export function judgeFtVram(q: {
  totalMiB: number
  usedMiB: number
  apps: FtGpuApp[]
  excludePids?: readonly number[]
}): { ok: boolean; freeMiB: number; holders: string[] } {
  const excluded = q.apps
    .filter((a) => (q.excludePids ?? []).includes(a.pid))
    .reduce((n, a) => n + a.usedMiB, 0)
  const freeMiB = q.totalMiB - (q.usedMiB - excluded)
  const holders = q.apps
    .filter((a) => !(q.excludePids ?? []).includes(a.pid) && a.usedMiB >= 200)
    .map((a) => `${a.name || '未知进程'} ${a.usedMiB} MiB`)
  return { ok: freeMiB >= FT_TRAIN_NEED_MIB, freeMiB, holders }
}

/**
 * 显存预检的提示语：够用返回 null。这里只提示、不拒绝——8G 卡上「关程序凑够 6.4G」经常凑不到，
 * 硬拦会把本来能跑的训练永久挡在门外；真正的兜底是训练真 OOM 时按原文点名（manager 认 OOM 标记）。
 */
export function ftVramNote(q: {
  totalMiB: number
  usedMiB: number
  apps: FtGpuApp[]
  excludePids?: readonly number[]
}): string | null {
  const verdict = judgeFtVram(q)
  if (verdict.ok) return null
  const holders = verdict.holders.length > 0 ? `；占卡较多的是 ${verdict.holders.join('、')}` : ''
  return `显存偏紧：整卡已用 ${q.usedMiB} / ${q.totalMiB} MiB，可空出约 ${verdict.freeMiB} MiB（训练建议 ${FT_TRAIN_NEED_MIB} MiB）${holders}。照常开跑；真不够会在训练里报 CUDA OOM，那时关掉占卡程序再点一次。`
}

/**
 * 打包结果的放行判据：两个 JSONL 都必须有。验证集不是可选项——官方脚本的
 * `eval_strategy="steps"` 是无条件的，空验证集会在 trainer 构造时直接 ValueError（安装版实测）。
 * 只有一条录音时 prepareFtDataset 会先拒打包并说清楚要补录，所以这里的报错文案只兜底。
 */
export function judgeFtDataset(pack: {
  ok: boolean
  trainPath: string
  evalPath: string
  error: string | null
}): { ok: boolean; error: string } {
  if (!pack.ok) return { ok: false, error: pack.error || '训练数据打包失败' }
  if (!pack.trainPath) return { ok: false, error: '训练集是空的——先录几条再打包' }
  if (!pack.evalPath) return { ok: false, error: '验证集没生成——至少录两条再打包' }
  return { ok: true, error: '' }
}

