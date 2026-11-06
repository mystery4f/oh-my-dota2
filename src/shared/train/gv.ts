/** GV（GPT-SoVITS）微调纯缝（T3）：版本映射、备料验收、s1/s2 训练配置拼装、注册载荷。 */

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
