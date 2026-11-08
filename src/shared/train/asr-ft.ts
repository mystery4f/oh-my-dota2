/** ASR 微调（T5）纯缝：训练/导出命令拼装、checkpoint 挑选、换模/回滚步骤、环境缺口点名。 */

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
}
/** 训练参数：试点（G15，20 句）实测收敛的 v5 版本为默认，轮数/lr/续训点可按 tuning 覆盖。 */
export function planAsrFtTrainArgv(paths: AsrFtPaths, data: AsrFtDatasetPlan, tuning?: AsrFtTrainTuning): string[] {
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
export const FT_MODEL_FILES = ['conv_frontend.onnx', 'encoder.int8.onnx', 'decoder.int8.onnx'] as const

/**
 * 导出产物齐全判据：sherpa 只认上面这三个 int8 文件（导出脚本默认量化）。
 * 训练腿跑完而导出腿还在写 decoder.int8.onnx 时，目录里已经有别的文件了——
 * 那时点「应用新模型」会把残缺目录转正，识别直接加载失败，所以必须逐件点名。
 */
export function missingFtExportFiles(names: readonly string[]): string[] {
  return FT_MODEL_FILES.filter((name) => !names.includes(name))
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

