/**
 * ASR 引擎类型表：一种引擎「长什么样」的唯一真相源。
 *
 * 这里只放知识（引擎叫什么、要哪些文件、能不能吃热词、怎么微调），不放事实
 * （磁盘上有没有、哪一份是现役）——事实在 `models.ts` 由目录探测推导，
 * 判断与副作用在主进程 `services/voice/asr-model.ts`。
 *
 * 为什么要有这张表：换一次识别模型曾经要动八处（worker 的 modelConfig 分支、
 * 三条目录候选、下载清单、失败文案、设置字段、训练腿的脚本路径、面板文案、探针），
 * 漏一处的表现是「按钮点了没反应」。按 `docs/STANDARDS.md` 的规矩，
 * 枚举乘固定字段就该写成表：**加引擎 = 表里加一行 + worker 适配器加一个键**，
 * 漏一个引擎由 `--asr-engines-probe` 变成红，而不是运行时静默。
 */
import { QWEN3_MODEL_FILES, type RuntimeModelFile } from '../voice-runtime'

export type AsrEngineId = 'qwen3' | 'paraformer'

/** worker 适配器的键，与 sherpa OfflineRecognizer 的 modelConfig 字段名同名，少一层映射。 */
export type AsrSherpaKind = 'qwen3Asr' | 'paraformer'

/** 模型目录扫描根（userData 相对路径）：手动解包、微调产物、运行时下载都落在这两处下面。 */
export const ASR_MODEL_ROOTS = ['asr-models', 'voice-runtime/models'] as const

export interface AsrDownloadSpec {
  /** hf-mirror 上的仓库（`<owner>/<name>`），文件按名直下。 */
  repo: string
  files: readonly RuntimeModelFile[]
}

/** 一次微调的转正产物：导出目录里的文件名 → 模型目录里 sherpa 要认的文件名。 */
export interface AsrFtArtifact {
  from: string
  to: string
}

export interface AsrFinetuneSpec {
  /** 训练入口形状，决定纯缝里 argv 怎么拼。 */
  trainer: 'qwen3-sft' | 'funasr-paraformer'
  /** 训练脚本候选（应用内布局在前，手动开发布局在后，检测服务逐个试）；funasr 走 `python -m` 模块，留空。 */
  trainScripts: readonly string[]
  exportScripts: readonly string[]
  /** 打包的导出工具（resources/ 下的文件名）：导出 + 量化 + 补 sherpa metadata 一步做完。 */
  exportTool?: string
  baseModelDirs: readonly string[]
  /** funasr 训练要的 hub 模型 id（拼进 `++model=`）；qwen3 走本地底模目录，留空。 */
  baseModelIds: readonly string[]
  /** 转正必需产物（相对模型目录）：sherpa 只认这几件，缺一件转正就加载失败。 */
  artifacts: readonly AsrFtArtifact[]
  /** 导出目录里没有、转正时要从别的目录借的东西（qwen3 借词表，paraformer 借 tokens.txt）。 */
  borrow: readonly { path: string; recursive?: boolean }[]
  dataset: 'qwen3-jsonl' | 'funasr-jsonl'
  /** 训练数据目录（userData 相对路径）。 */
  datasetDir: string
  /** 训练环境额外要装、缺了要在面板点名的 python 包。 */
  pythonExtra: readonly string[]
  /** 装环境时要 pip 的冻结版本（qwen 那几个已在安装器的冻结清单里，这里只补引擎特有的）。 */
  pips: readonly string[]
  /**
   * 每步实测耗时（秒）：只给开训前的时长估算用（`shared/train/asr-ft` 的 `estimateFtCost`），
   * 既不排程也不拦截。数字来自 docs/BENCH.md 的实测（G14，RTX 4060 8G），换机器就换这里。
   */
  secPerStep: number
}

export interface AsrEngineSpec {
  id: AsrEngineId
  label: string
  sherpaKind: AsrSherpaKind
  /** 现役目录（userData 相对路径）：下载与微调转正都落这儿。 */
  canonicalRel: string
  /** 归属判定：userData 相对路径，末尾 `*` 是前缀匹配；顺序即优先级。 */
  dirPatterns: readonly string[]
  /** 判 ready 的必备文件（相对模型目录）。 */
  requiredPaths: readonly string[]
  /** 下载清单；null = 只能手动放置或微调产出。 */
  download: AsrDownloadSpec | null
  /** 热词：prompt = 文本提示（Qwen3 那条路）；none = 不支持的引擎老实写 none。 */
  hotwords: 'prompt' | 'none'
  /** 标点：builtin = 模型自带；external = 需要外挂标点；none = 都没有。 */
  punctuation: 'builtin' | 'external' | 'none'
  /** 输出是空格分隔的单字时要拼接（FunASR 家族）。 */
  joinChars: boolean
  finetune: AsrFinetuneSpec | null
  /** 一句话代价说明，面板直接显示。 */
  note: string
}

export const ASR_ENGINES: Record<AsrEngineId, AsrEngineSpec> = {
  qwen3: {
    id: 'qwen3',
    label: 'Qwen3-ASR 0.6B',
    sherpaKind: 'qwen3Asr',
    canonicalRel: 'asr-models/qwen3-asr',
    dirPatterns: ['asr-models/qwen3-asr*', 'asr-models/sherpa-onnx-qwen3-asr*', 'voice-runtime/models/qwen3-asr*'],
    requiredPaths: [
      'conv_frontend.onnx',
      'encoder.int8.onnx',
      'decoder.int8.onnx',
      'tokenizer/vocab.json',
      'tokenizer/merges.txt'
    ],
    download: {
      repo: 'csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25',
      files: QWEN3_MODEL_FILES
    },
    hotwords: 'prompt',
    punctuation: 'builtin',
    joinChars: false,
    finetune: {
      trainer: 'qwen3-sft',
      trainScripts: ['sft/qwen3_asr_sft.py', 'Qwen3-ASR/finetuning/qwen3_asr_sft.py'],
      exportScripts: ['export/export_qwen3_asr_onnx.py', 'Qwen3-ASR-onnx/export_qwen3_asr_onnx.py'],
      baseModelDirs: ['models/Qwen3-ASR-0.6B'],
      baseModelIds: [],
      artifacts: [
        { from: 'conv_frontend.onnx', to: 'conv_frontend.onnx' },
        { from: 'encoder.int8.onnx', to: 'encoder.int8.onnx' },
        { from: 'decoder.int8.onnx', to: 'decoder.int8.onnx' }
      ],
      borrow: [{ path: 'tokenizer', recursive: true }],
      dataset: 'qwen3-jsonl',
      datasetDir: 'asr-ft-datasets',
      pythonExtra: [],
      // 这条腿要的包（qwen-asr 等）已经在 install 的冻结清单里，这里不重复。
      pips: [],
      // 4060 8G 实测 G14 全链 660 步 1:05:18，全程均 5.9 秒/步（尾段纯训练 3.4 秒/步，
      // 估时取全程均：校验与存盘也是用户要等的时间）。
      secPerStep: 5.9
    },
    note: '逐字生成，短句约 0.7 秒；模型约 980MB'
  },
  paraformer: {
    id: 'paraformer',
    label: 'Paraformer（阿里 FunASR）',
    sherpaKind: 'paraformer',
    canonicalRel: 'asr-models/paraformer-zh',
    dirPatterns: ['asr-models/paraformer-zh*', 'asr-models/sherpa-onnx-paraformer*'],
    requiredPaths: ['model.int8.onnx', 'tokens.txt'],
    download: {
      repo: 'csukuangfj/sherpa-onnx-paraformer-zh-2024-03-09',
      files: [
        {
          path: 'model.int8.onnx',
          bytes: 227330205,
          sha256: '90bc03034ae1bef9575f8cc798cd1519c8be8aa9e8b458a033e32017ff4d584c'
        },
        { path: 'tokens.txt', bytes: 75354, sha256: '6c0e3b35cece259829e6cb5b8d90d13db88f61ea3a2953d11898e4b2bfd7a2e2' }
      ]
    },
    hotwords: 'none',
    punctuation: 'none',
    joinChars: false,
    finetune: {
      trainer: 'funasr-paraformer',
      trainScripts: [],
      exportScripts: [],
      baseModelDirs: [],
      // 官方 finetune.sh 用的就是这条 hub id；FunASR 从它拿训练配置和预训练权重。
      baseModelIds: ['iic/speech_paraformer-large_asr_nat-zh-cn-16k-common-vocab8404-pytorch'],
      // 导出走打包的 asr-ft-export-funasr.py：它写完 model.int8.onnx 与 tokens.txt。
      // FunASR 自己的 export 只给 model.onnx/model_quant.onnx，既没有 sherpa 要的 metadata，
      // 也不写 tokens.txt，拿那种文件 sherpa 直接拒绝加载。
      exportTool: 'asr-ft-export-funasr.py',
      artifacts: [
        { from: 'model.int8.onnx', to: 'model.int8.onnx' },
        { from: 'tokens.txt', to: 'tokens.txt' }
      ],
      borrow: [{ path: 'tokens.txt' }],
      dataset: 'funasr-jsonl',
      datasetDir: 'asr-ft-datasets',
      // funasr 的 hub 下载只走 modelscope（download_from_hub.py），缺了底模就拉不到；
      // torchaudio 是它 import 时才暴露的隐式依赖，缺了一训练就炸。
      pythonExtra: ['funasr', 'torchaudio', 'modelscope', 'onnxruntime', 'onnx'],
      pips: ['funasr==1.0.27', 'modelscope'],
      // 4060 Laptop 实测 G14：600 步（30 轮 × 20 条）约 6 分钟，均 0.6 秒/步，已含校验与存盘。
      secPerStep: 0.6
    },
    note: '非自回归：约 0.07 秒/句、无标点、不吃热词；同批 40 条错字率 13.7%（Qwen3 底模 6.27%）'
  },
}

/** 表的有序视图（面板顺序 = 这里的顺序）。 */
export const ASR_ENGINE_LIST: readonly AsrEngineSpec[] = Object.values(ASR_ENGINES)

/** 判 ready 要看的所有相对路径（跨引擎去重）：目录探测按这份清单一次 stat 完。 */
export function requiredPathsAll(): string[] {
  const seen = new Set<string>()
  for (const spec of ASR_ENGINE_LIST) for (const path of spec.requiredPaths) seen.add(path)
  return [...seen]
}

/** 可下载的引擎（面板下载按钮只用这些）。 */
export function downloadableEngines(): AsrEngineSpec[] {
  return ASR_ENGINE_LIST.filter((spec) => spec.download !== null)
}
