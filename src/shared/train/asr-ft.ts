/**
 * ASR 微调（T5）纯缝：训练/导出命令拼装、checkpoint 挑选、换模/回滚步骤、环境缺口点名。
 *
 * 五十来个导出，按「谁在调用」认路，别按文件顺序读：
 *   - 开训口径只有一个门：planFtTuning。轮数与学习率都从它出，调用点不许另拼；
 *     两条训练腿的差异靠 AsrFtTrainer 一处分支承担。
 *   - 轮数推导在它下面：deriveFtEpochs / deriveFtEpochsFor / deriveFtIncrementalEpochs；
 *     运行期只经 planFtTuning，探针（probes/train.ts）才直接调。
 *   - 命令拼装：planAsrFtTrainArgv / planAsrFtExportArgv，输入都是 AsrFtPaths + AsrFtDatasetPlan。
 *   - 换模与回滚成对改：asrFtSwapSteps / asrFtRollbackSteps（probes/asr-swap.ts 钉着顺序）。
 *   - 显存：parseNvidiaComputeApps + judgeFtVram，门槛常量 FT_TRAIN_NEED_MIB。
 * 不拆成几个文件：它们共享同一对形状（AsrFtPaths / AsrFtDatasetPlan），拆开只会让调用方
 * 多跳一层，删除测试过不了——删掉任一导出，调用点都得重写同一段规则。
 */
import { ASR_ENGINE_LIST, ASR_ENGINES, type AsrEngineId } from '../asr/engines'
import { WAV_BYTES_PER_MS, WAV_HEADER_BYTES } from '../wav'
import type { FtCorrectionSamples } from './corrections'
import { holdoutTakes } from './dataset'
import { scriptTextForKey, type FtScriptGroup } from './recording'

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

/** 一次 ASR 微调要吃的三样东西：打包产物和这次的输出目录。 */
export interface AsrFtDatasetPlan {
  trainJsonl: string
  evalJsonl: string
  runDir: string
}
/**
 * 目标总步数≈110：只决定「同一批录音看几遍」，不影响打包进数据的条数（每条都吃，轮数是整批的重复次数）。
 * 43 条时每轮 11 步 ⇒ 10 轮 ≈ 110 步 ≈ 6 分钟。2026-11-09 由 400（36 轮）再降到 110：公开做法是音频
 * 少于一小时训 5–10 遍，同脚本的公开配方只跑 3 轮；再往上加，val 只有 2 条同源句子，看不出到底学会了还是背题。
 * 要更久就调这里，别在调用点拼轮数（面板估时与真开跑都读它）。
 */
export const FT_TARGET_STEPS = 110
/**
 * 一步吃几条：引擎表微调段的 `samplesPerStep` 是唯一一份（qwen3 batch 1 × grad_acc 4、funasr batch 1），
 * 训练 argv 也读它——改批大小只改表，轮数折算与估算的步数自动跟上。
 */
export function ftSamplesPerStep(trainer: AsrFtTrainer): number {
  for (const spec of ASR_ENGINE_LIST) {
    if (spec.finetune?.trainer === trainer) return spec.finetune.samplesPerStep
  }
  return 1
}

/** 每轮几步：训练条数 / 一步吃几条，向上取整（最后一块不满也算一步）。 */
function ftStepsPerEpoch(trainer: AsrFtTrainer, trainCount: number): number {
  return Math.max(1, Math.ceil(trainCount / ftSamplesPerStep(trainer)))
}

/**
 * 冒烟开关：环境变量 `OMD2_FT_EPOCHS=1` 把轮数钉死成指定值。只为一件事——把「打包 → 训练 → 导出 → 换模」
 * 这条链快速跑通（1 轮 = 每轮几步就跑几步，43 条约 11 步）。渲染层没有 process，取不到就当没设。
 */
function smokeEpochs(): number {
  const raw = typeof process === 'undefined' ? undefined : process.env?.OMD2_FT_EPOCHS
  const n = Number(raw)
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : 0
}
/** 自适应轮数：步/轮 = ceil(训练条数 / 每步吃几条)，轮 = clamp(round(目标步数 / 步每轮), 3, 66)。数据为 0 回 66（不会发生，防御）。 */
export function deriveFtEpochs(trainCount: number): number {
  return deriveFtEpochsFor('qwen3-sft', trainCount)
}

/** funasr 目标定 600 步（比 qwen3 的 800 短）：一步 = 1 条（表里的 samplesPerStep）时，40 条约 15 轮。 */
export const FT_FUNASR_TARGET_STEPS = 600

/**
 * 按 trainer 折算轮数：两条腿只有目标步数与上下限不同，每轮几步一律走 `ftStepsPerEpoch`。
 * qwen3 的保底从 10 轮降到 3 轮（2026-11-09）：数据一多，10 遍就成了硬性下限量——400 条也要跑 1000 步、
 * 近一小时，是「背题」最容易发生的那一侧。3 遍是「至少把数据看过几眼」的下线，够不着目标步数时别再往上顶。
 */
export function deriveFtEpochsFor(trainer: AsrFtTrainer, trainCount: number): number {
  const funasr = trainer === 'funasr-paraformer'
  if (trainCount <= 0) return funasr ? 20 : 66
  const smoke = smokeEpochs()
  if (smoke) return smoke
  const stepsPerEpoch = ftStepsPerEpoch(trainer, trainCount)
  const target = funasr ? FT_FUNASR_TARGET_STEPS : FT_TARGET_STEPS
  return funasr
    ? Math.min(40, Math.max(4, Math.round(target / stepsPerEpoch)))
    : Math.min(66, Math.max(3, Math.round(target / stepsPerEpoch)))
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
  const stepsPerEpoch = ftStepsPerEpoch('funasr-paraformer', trainCount)
  return Math.min(12, Math.max(2, Math.round(FT_INCREMENTAL_TARGET_STEPS / stepsPerEpoch)))
}

/** 开训口径：两条腿的轮数与学习率**只能**从这里出，别在调用点各拼一套。 */
export type AsrFtMode = 'fresh' | 'incremental'

/** IPC/面板传来的模式是 unknown：垃圾值一律按「从底模重训」，增量必须是显式选择。 */
export function normalizeAsrFtMode(value: unknown): AsrFtMode {
  return value === 'incremental' ? 'incremental' : 'fresh'
}

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

/**
 * 开训前的时长估算（#65）：显示用，既不排程也不拦截。
 * 只做乘法——轮数直接复用 planFtTuning（与真开跑同一份推导），每步耗时取引擎表的微调段。
 * 量级依据（docs/BENCH.md）：G14 38 训 + 2 验 660 步实测 65 分钟、20 条 Paraformer 600 步约 6 分钟；
 * 同一份数据按这里算出来正好是 65 / 6 分钟。机器、显存、校验密度不同会差几成到倍数，所以一律写「估算」。
 * 总时长（audioMs）只进文案，不参与乘法：实测基准只有「秒/步」，没有随音频长度变化的第二项，
 * 按音频折算等于编一个没测过的系数（理由与边界写进 docs/BENCH.md）。
 */
export interface FtCostEstimate {
  /** 这次要跑的步数：增量已扣掉 checkpoint 里已有的步数。 */
  steps: number
  /** 折成分钟（四舍五入，至少 1；没数据时 0）。 */
  minutes: number
  /** 进训练的条数 = 总条数 − 这次真正留作验证的条数（增量按上一轮 evalKeys 算，不是默认 holdout）。 */
  trainTakes: number
  /** 这次新录的条数（增量文案要用：新增几条 ≠ 要过多少数据）。 */
  pendingTakes: number
  /** 面板直接显示的那一句：约 N 步 / 约 X 分钟。 */
  label: string
  /** 数字从哪来（哪条腿、多少秒/步），估偏了能追到来源。 */
  basis: string
}

/** 这条训练腿的每步实测耗时（秒）与引擎名，全部来自引擎表；表里没声明就 null（别编数字）。 */
export function ftCostBasis(trainer: AsrFtTrainer): { secPerStep: number; engineLabel: string } | null {
  for (const spec of ASR_ENGINE_LIST) {
    if (spec.finetune?.trainer === trainer) return { secPerStep: spec.finetune.secPerStep, engineLabel: spec.label }
  }
  return null
}

/**
 * 「大概多少步 / 大概几分钟」：输入的条数与总时长来自当前录音账本，轮数走 planFtTuning。
 * 0 条、1 条、几百条都返回同一形状（不抛）；takes 是账本里能进训练的条数——逐句录音与
 * 「改对一句」落账的纠错样本（G01-Tnn）都算，没纠错的自由说 T 键不进账本，自然不在内。
 * 验证集条数默认取尾部 holdout（与开训打包 splitTrainEval 同一口径）；增量要传 evalTakes =
 * 上一轮 evalKeys 里今天还在的条数——真开跑就是拿这些当验证集，不传就会多算一条训练数据。
 */
export function estimateFtCost(input: {
  mode: AsrFtMode
  trainer: AsrFtTrainer
  /** 账本里能进训练的录音条数（逐句已录句 + 纠错样本；没纠错的自由说录音不进账本）。 */
  takes: number
  /** 这些录音的总时长（毫秒）：只进文案，不影响步数。 */
  audioMs?: number
  /** 这次真正留作验证的条数；不给就按默认尾部 holdout。 */
  evalTakes?: number
  /** 续训起点已到第几步（qwen3 增量用它算「这次还要跑多少」）。 */
  lastStep?: number
  /**
   * 账本里还没训过的条数：增量只训这些，所以它同时是增量的训练集基数（不是文案点缀）。
   * 不传时增量退回「全部 takes」的老算法——只有探针会那样调，面板永远传。
   */
  pendingTakes?: number
  /** 这些新录音的总时长（毫秒）：只进文案。 */
  pendingAudioMs?: number
}): FtCostEstimate {
  const takes = Math.max(0, Math.floor(input.takes))
  const cost = ftCostBasis(input.trainer)
  if (cost === null) {
    return { steps: 0, minutes: 0, trainTakes: 0, pendingTakes: 0, label: '这条训练腿没有每步耗时基准，估算不了', basis: '引擎表的微调段里没写 secPerStep' }
  }
  const basis = `按 ${cost.engineLabel} ${cost.secPerStep} 秒/步（4060 实测基准，见 docs/BENCH.md）估算：含校验与存盘，机器 / 显存 / 数据量一变就会差几成到倍数`
  if (takes === 0) return { steps: 0, minutes: 0, trainTakes: 0, pendingTakes: 0, label: '还没录训练集：先录几条再估', basis }
  // 增量只训「还没训过」的那几条（docs/adr/asr-train-rewrite.md）：训练集基数就是新增条数，
  // 上一轮的验证集是额外文件、不重新切 holdout，所以 evalTakes 在增量里不参与步数。
  const incremental = input.mode === 'incremental' && input.pendingTakes !== undefined
  const pending = Math.max(0, Math.floor(input.pendingTakes ?? 0))
  if (incremental && pending === 0) {
    return {
      steps: 0,
      minutes: 0,
      trainTakes: 0,
      pendingTakes: 0,
      label: '账本里没有新录音：增量微调只训没训过的句子，要重练全部数据请用全量重训',
      basis
    }
  }
  const evalTakes = incremental ? 0 : Math.min(takes, Math.max(0, Math.floor(input.evalTakes ?? holdoutTakes(takes))))
  const trainCount = incremental ? pending : takes - evalTakes
  // 轮数必须带 lastStep：qwen3 续训的轮数是「(lastStep + 200) / 每轮步数」向上取整，不带就少算。
  const epochs = planFtTuning({ mode: input.mode, trainer: input.trainer, trainCount, lastStep: input.lastStep }).epochs ?? 1
  const budget = epochs * ftStepsPerEpoch(input.trainer, trainCount)
  // 增量 qwen3 的 checkpoint 里已经有 lastStep 步：这次要等的只是超出那部分，别把已跑的要一遍。
  const done =
    input.mode === 'incremental' && input.trainer !== 'funasr-paraformer' ? Math.max(0, Math.floor(input.lastStep ?? 0)) : 0
  const steps = Math.max(0, budget - done)
  const minutes = steps === 0 ? 0 : Math.max(1, Math.round((steps * cost.secPerStep) / 60))
  const audio = ftAudioLabel(incremental ? (input.pendingAudioMs ?? input.audioMs ?? 0) : (input.audioMs ?? 0))
  // 一句话要同时回答「多久」和「值不值」：全量说清训练/验证条数，增量说清只训新增的那几条。
  const detail = incremental
    ? `新增 ${pending} 条，只训这 ${pending} 条，从上一轮权重接着跑 ${epochs} 轮`
    : `${trainCount} 条进训练、${evalTakes} 条留验证，从底模重训 ${epochs} 轮`
  return {
    steps,
    minutes,
    trainTakes: trainCount,
    pendingTakes: pending,
    label:
      steps === 0
        ? '约 0 步 / 不用跑（账本里没有新录音）'
        : `约 ${steps} 步 / 约 ${minutes} 分钟（${detail}${audio === '' ? '' : `，${audio}音频`}，估算）`,
    basis
  }
}

/** 录音总时长的人话（不足一分钟按秒说）：只用于估算文案。 */
function ftAudioLabel(ms: number): string {
  if (ms <= 0) return ''
  if (ms < 60_000) return `${Math.max(1, Math.round(ms / 1000))} 秒`
  return `${Math.round(ms / 60_000)} 分钟`
}

/** 续训在旧 checkpoint 之上多跑的轮数：两遍新数据（2026-11-09 由固定 200 步改来）。 */
export const FT_RESUME_EXTRA_EPOCHS = 2

/**
 * 续训轮数：HF Trainer 拿 resume_from_checkpoint 恢复 global_step，max_steps（轮数×步/轮）一旦
 * 不大于已到的步数就整轮直接跳过（一行日志都没有）。所以轮数必须保证
 * 总步数 > 上次 checkpoint 步数——ceil 之后再 +2 一定满足。
 *
 * 补多少只看「新数据看几遍」，不按固定步数补：固定 200 步时，只加一条录音也要重跑近一小时
 * （2026-11-09 实测 352 步 / 17 分钟，用户当场提出）。两轮是下限档，与 FT_TARGET_STEPS 的口径一致。
 */
export function deriveFtResumeEpochs(trainCount: number, lastStep: number): number {
  return Math.ceil(lastStep / ftStepsPerEpoch('qwen3-sft', trainCount)) + FT_RESUME_EXTRA_EPOCHS
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
    // 一步吃几条由引擎表的 samplesPerStep 定（batch_size 1 ⇒ grad_acc = samples/step）：轮数与估时都读同一项。
    '--grad_acc', String(ftSamplesPerStep(paths.trainer)),
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
 * batch_size 取引擎表的 samplesPerStep（官方按 6000 token 一档，这里按条）、num_workers 0（Windows 子进程不稳）、不跑 deepspeed。
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
    // example 批：一条录音一步；数字取引擎表的 samplesPerStep，与轮数折算同源。
    `++dataset_conf.batch_size=${ftSamplesPerStep(paths.trainer)}`,
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
    // 窗口只影响磁盘，不管窗口多大都盖不住「虎口」：trainer 收尾按 val_acc 排序取第一名，
    // 淘汰却按 val_acc 取最差那名，两个方向在**并列**时正好撞在一起——val 只有 2 条时 acc 是
    // 0/0.5/1 这类离散值，并列极常见，于是挑中的名字（常是最早那条 model.pt.ep0.20）早被淘汰
    // （实测 2026-11-09：15 epoch / 585 步跑完，收尾 RuntimeError: No checkpoints found for
    // averaging，目录只剩 ep13.20/ep14/ep14.20/ep15）。所以训练栈这边留 4 个只为省磁盘，
    // 收尾失败由 manager.salvageFunasrAverage() 兜住：权重在 model.pt.best，导出腿认它。
    '++train_conf.keep_nbest_models=4',
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
  /** 纠错样本（#66）：自由说组里由「改对一句」攒下的样本，条数/字节与到顶提示。 */
  corrections: FtCorrectionSamples
  env: { ok: boolean; gaps: string[]; envRoot: string }
  /** 这次训练落在哪个引擎上：面板必须能说清「训的是谁」，不然用户只能猜。 */
  target: { engineId: string; label: string; trainer: AsrFtTrainer; modelDir: string; baseModel: string }
  swap: { activeExists: boolean; bakExists: boolean; nextExists: boolean; lastExportDir: string | null }
  /** 已训标记：最近一次微调的账本 vs 当前录音，按组算 done/total/stale（key = 组 id）。 */
  coverage: Record<string, FtCoverageGroup>
  /** 待训数据：账本里还没被任何一次 run 吃过的最新录音。 */
  pending: FtPendingTakes
  /** 一键安装的即时状态：null = 这次会话还没跑过安装。 */
  install: AsrFtInstallState | null
  /** 开训前的估时（#65）：两种开训方式各一份，面板切换模式不必再问主进程。 */
  estimate: Record<AsrFtMode, FtCostEstimate>
  /** 估算依据的一句话（面板提示用；与 estimate.label 同源，避免面板自己拼）。 */
  estimateBasis: string
  /** 稿子改了、但这条录音还是按旧文本录的键（Gxx-Lnn）：面板把这些行标成「需重录」。 */
  scriptStale: string[]
}

/** 开训闸门看到的两件事实：显存提示，以及上一轮的权重是否真的能接（增量）。panel 只显示，不自己推。 */
export interface AsrFtFacts {
  /** 非空就是一条件显存告警；查不到 nvidia-smi 时是 null。 */
  vramNote: string | null
  /** 与开训闸门同一判据：最新账本对得上，且上一轮的 pytorch 权重/checkpoint 还躺在磁盘上。 */
  incremental: boolean
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

/** run.json 的形状：一次微调从开跑到收场的流水（训练目录自己的账本，面板不读它）。 */
export interface FtRunMeta {
  runId: string
  startedAt: number
  /** 这一轮是从底模重训（fresh）还是接着上一轮权重（incremental）；老 run.json 没有这个字段。 */
  mode?: AsrFtMode
  epochs: number
  lr: string
  resumeFrom: string | null
  status: 'running' | 'trained' | 'applied' | 'failed'
  finishedAt: number | null
  exportDir: string
  /** 开跑写死 false；「转正过」记进 runs.db 的 applied（面板只读库），这里不再回写。 */
  applied: boolean
}

export interface FtCoverageGroup {
  done: number
  total: number
  stale: number
}

/**
 * 已训标记：被任意一次 run 真正吃过（run_id 非空）的条目 vs 磁盘现状，按组算 done/total/stale。
 * key+bytes+mtimeMs 全等 = 训过；同 key 但文件变过 = stale（重录了，得再训）；账本没有 = 没训过。
 * current 由调用方只喂逐句键（L 键，见 asrFtStatus 的过滤）：自由说组没有稿子行，改对落账的纠错样本（G01-Tnn）
 * 另有 corrections 一栏，混进来会让「已训 x/20」凭空多出分母。
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

/**
 * 谱系判据（增量能不能接着跑）：上次打包过的每一条，键、文本、字节、mtime 都得和今天一模一样。
 * 只比字节/mtime 不够——改稿但没重录时 wav 没动，账本文本却变了：那时接着旧权重训，
 * 等于把新标签硬塞进旧模型，用户的口径是「改了就回底模重训，只有新增才增量」。
 */
export interface FtLineage {
  incremental: boolean
  /** 键还在但变了（文本或音频）：面板点名哪几句。 */
  changed: { key: string; from: string; to: string }[]
  /** 上次训过、现在稿子里没了：增量接不上。 */
  removed: string[]
}

export function ftLedgerLineage(
  past: readonly FtLedgerEntry[],
  current: readonly FtLedgerEntry[]
): FtLineage {
  if (past.length === 0) return { incremental: false, changed: [], removed: [] }
  const now = new Map(current.map((entry) => [entry.key, entry]))
  const changed: { key: string; from: string; to: string }[] = []
  const removed: string[] = []
  for (const entry of past) {
    const live = now.get(entry.key)
    if (!live) {
      removed.push(entry.key)
      continue
    }
    if (live.bytes !== entry.bytes || live.mtimeMs !== entry.mtimeMs || live.text !== entry.text) {
      changed.push({ key: entry.key, from: entry.text, to: live.text })
    }
  }
  return { incremental: changed.length === 0 && removed.length === 0, changed, removed }
}

/**
 * 需要重录的键：稿子改了文本，但磁盘上这条录音还是按旧文本录的。
 * 判据是「账本里落的文本 ≠ 当前稿子的文本」——重录会覆盖 wav 并把新文本写进账本，标记自动消失。
 */
export function scriptStaleKeys(
  groups: readonly FtScriptGroup[],
  ledger: readonly FtLedgerEntry[]
): string[] {
  return ledger
    .filter((entry) => {
      const text = scriptTextForKey(groups, entry.key)
      return text !== null && text !== entry.text
    })
    .map((entry) => entry.key)
}

/** 8G 卡实测训练净占 ~6.2G（峰值 7661 − 空闲基线 1488）+ 200 MiB 余量。这是「建议线」，不是硬闸。 */
export const FT_TRAIN_NEED_MIB = 6400

/**
 * wav 时长（毫秒）：标准 44 字节头 + 每毫秒字节数，常量归 `src/shared/wav.ts` 一份
 * （编码器、训练集字节数换算、这里是同一套数字）。
 */
export function ftWavDurationMs(bytes: number): number {
  return Math.max(0, Math.round((bytes - WAV_HEADER_BYTES) / WAV_BYTES_PER_MS))
}

/** 待训条数到这条线就把提示语换成「够再训一次了」——只是提示，绝不自动开训。 */
export const FT_PENDING_PROMPT_AT = 20

/** 待训摘要：条数、总时长，以及面板直接显示的那句人话。 */
export interface FtPendingTakes {
  /** 待训条数（每个 key 只算最新修订）。 */
  count: number
  /** 这些录音的总时长（毫秒）。 */
  durationMs: number
  /** 跑过 asr-ft 没有：没有历史时文案是「从未训练」而不是「上次训练后」。 */
  trained: boolean
  /** 够再训一次了（只是提示）。 */
  prompt: boolean
  label: string
}

/** 账本行里这个纯缝只需要这几个字段（主进程的 DatasetEntry 结构性满足）。 */
export interface FtPendingLedgerRow {
  key: string
  revision: number
  bytes: number
  runId: string | null
}

/**
 * 「还有多少新数据等着训练」：账本里每个 key 只看最新修订，run_id 为空的就是没被任何一次 run 吃过的。
 * 重录一句（稿子没变）还是同一个修订、run_id 保留，所以不会算成新数据；改稿才是新修订。
 * 条数、时长、已训/未训都从这一份账本推，不重走录音目录。
 */
export function summarizePendingTakes(input: {
  entries: readonly FtPendingLedgerRow[]
  hasRun: boolean
  threshold?: number
}): FtPendingTakes {
  const limit = input.threshold ?? FT_PENDING_PROMPT_AT
  const latest = new Map<string, FtPendingLedgerRow>()
  for (const entry of input.entries) {
    const seen = latest.get(entry.key)
    if (!seen || entry.revision > seen.revision) latest.set(entry.key, entry)
  }
  const rows = [...latest.values()].filter((entry) => entry.runId === null)
  const count = rows.length
  const durationMs = rows.reduce((sum, entry) => sum + ftWavDurationMs(entry.bytes), 0)
  const seconds = Math.round(durationMs / 1000)
  const prompt = count >= limit
  const base = !input.hasRun
    ? count > 0
      ? `从未训练过，已录 ${count} 条（约 ${seconds} 秒）`
      : '从未训练过，还没录过音'
    : count > 0
      ? `上次训练后有 ${count} 条新录音（约 ${seconds} 秒）`
      : '上次训练后还没有新录音'
  return {
    count,
    durationMs,
    trained: input.hasRun,
    prompt,
    label: prompt ? `${base}，够再训一次了` : base
  }
}

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

