import { app } from 'electron'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  advanceRecording,
  initialRecordingState,
  nextUnrecordedLine,
  RECORDING_LIMITS,
  parseRecordingKeyParts,
  recordingKey,
  resolveFtScript,
  scriptTextForKey,
  shouldKeepTake,
  takeLineId
} from '@shared/train/recording'
import {
  buildFtDatasetEntries,
  buildFtGroupProgress,
  buildFtJsonlLine,
  splitIncrementalEval,
  splitTrainEval,
  type FtDatasetGroupView
} from '@shared/train/dataset'
import {
  canStartTrain,
  deriveTrainPlan,
  inferenceHoldLabel,
  normalizeTrainKind,
  shouldPauseInference,
  shouldResumeInference,
  type TrainTaskStatus
} from '@shared/train/task'
import { parseTrainProgress } from '@shared/train/progress'
import {
  asrFtRollbackSteps,
  asrFtSwapSteps,
  deriveAsrFtEnvGaps,
  deriveFtEpochs,
  deriveFtIncrementalEpochs,
  deriveFtResumeEpochs,
  FT_PENDING_PROMPT_AT,
  ftLedgerMatchedOnDisk,
  ftTrainCoverage,
  ftWavDurationMs,
  summarizePendingTakes,
  judgeFtVram,
  ftVramNote,
  judgeFtDataset,
  missingFtExportFiles,
  missingFtSlotFiles,
  ftAppliedNote,
  incrementalWeightFile,
  parseNvidiaComputeApps,
  pickLastCheckpointName,
  planAsrFtExportArgv,
  planAsrFtTrainArgv,
  planFtTuning,
  normalizeAsrFtMode,
  estimateFtCost,
  ftCostBasis,
  type AsrFtPaths,
  type FtLedgerEntry
} from '@shared/train/asr-ft'
import {
  buildS1TrainConfigData,
  buildS2TrainConfigData,
  GV_LEGS,
  GV_VERSION_DEFAULT,
  GV_VERSION_INFO,
  judgeGvDataset,
  normalizeGvVersion
} from '@shared/train/gv'
import {
  buildTrainRun,
  compactMetricSeries,
  compareRunsDesc,
  finishTrainRun,
  METRIC_SERIES_MAX,
  parseAsrTrainerState,
  parseGvTrainLog,
  type TrainRunRecord
} from '@shared/train/run'
import { judgeAsrPreflight, judgeGvPreflight, preflightBlocks } from '@shared/train/preflight'
import { pickLatestUvAsset, planAsrFtInstallSteps, resolveUvWheelUrl, uvWheelCandidates } from '../services/train/asr-ft-install'
import { findIncrementalSource, stageIncrementalSource } from '../services/train/asr-ft'
import {
  closeTrainStore,
  packedLedgerForRun,
  findDatasetEntry,
  importLegacyTrainData,
  listDatasetEntries,
  listTrainRuns,
  loadTrainRun,
  markDatasetEntryTrained,
  patchTrainRun,
  pruneTrainRuns,
  recordDatasetTake,
  forgetDatasetTake,
  saveDatasetLedger,
  saveTrainRun,
  trainDbPath,
  useTrainDatabase
} from '../services/train/run-store'
import {
  ensureSovitsServer,
  setInferenceHold,
  sovitsInferenceHeld,
  sovitsServerLogs
} from '../services/voice/sovits-server'

/**
 * `--train-probe`：训练决策纯缝的全量行为锁（互斥闸/推理互斥/计划推导/日志行→进度/录音判定/GV 微调配置/存储层）。
 * 纯函数零进程零网络；存储层那一组对着临时库跑（不碰 data/ 里的真库）；
 * 进程生命周期（spawn/停/树杀）进 docs/ACCEPTANCE.md 人工验收。
 */

/**
 * 接线钉：manager 里「开跑置位 / 收场清除」两句。任务生命周期要真 spawn 才走得到，
 * 纯缝探针跑不了进程，所以这两句以源码文本为契约钉住——删掉任意一句（例如收场忘了清）本探针立刻红。
 * 读不到源码（安装版没有 src/）不判红：行为半边仍由下面的运行时断言守着。
 */
function managerHoldWiring(): { readable: boolean; set: boolean; clear: boolean } {
  const file = join(process.cwd(), 'src/main/services/train/manager.ts')
  if (!existsSync(file)) return { readable: false, set: false, clear: false }
  const source = readFileSync(file, 'utf8')
  return {
    readable: true,
    set: /setInferenceHold\(\s*true\s*\)/.test(source),
    clear: /setInferenceHold\(\s*false\s*\)/.test(source)
  }
}

/**
 * 接线钉：#64 录音存盘那条路要把这条录音落进账本（run_id 空），否则「录一条待训数字就涨」不成立。
 * 同 managerHoldWiring：读不到源码（安装版）不判红。
 */
function recordLedgerWiring(): { readable: boolean; wired: boolean } {
  const file = join(process.cwd(), 'src/main/services/train/ft-record.ts')
  if (!existsSync(file)) return { readable: false, wired: false }
  const source = readFileSync(file, 'utf8')
  return { readable: true, wired: /recordDatasetTake\(/.test(source) && /forgetDatasetTake\(/.test(source) }
}

interface Row {
  name: string
  ok: boolean
  detail: string
}

const cases: Row[] = []

function push(name: string, ok: boolean, detail: string): void {
  cases.push({ name, ok, detail })
}

export async function runTrainProbe(): Promise<void> {
  // —— 单任务互斥闸 ——
  push('没有任务 → 能开', canStartTrain(null).ok, JSON.stringify(canStartTrain(null)))
  push('running → 拒绝', canStartTrain('running').ok === false, canStartTrain('running').reason ?? '')
  push('preparing → 拒绝', canStartTrain('preparing').ok === false, canStartTrain('preparing').reason ?? '')
  push('stopping → 拒绝（等退干净）', canStartTrain('stopping').ok === false, canStartTrain('stopping').reason ?? '')
  push('done → 能开', canStartTrain('done').ok, JSON.stringify(canStartTrain('done')))
  push('failed → 能开', canStartTrain('failed').ok, JSON.stringify(canStartTrain('failed')))
  push('stopped → 能开', canStartTrain('stopped').ok, JSON.stringify(canStartTrain('stopped')))

  // —— 推理互斥（T2 接线的判定来源） ——
  const active: TrainTaskStatus[] = ['preparing', 'running', 'stopping']
  const ended: (TrainTaskStatus | null)[] = [null, 'done', 'failed', 'stopped']
  push('活着的任务都要推理让路', active.every((s) => shouldPauseInference(s)) && ended.every((s) => !shouldPauseInference(s)), `${active}->pause ${ended}->!pause`)
  push('退干净才恢复推理', ended.every((s) => shouldResumeInference(s)) && active.every((s) => !shouldResumeInference(s)), `${ended}->resume ${active}->!resume`)
  push('互斥判定互补', ['idle', 'preparing', 'running', 'stopping', 'done', 'failed', 'stopped'].every((s) => shouldPauseInference(s as TrainTaskStatus) !== shouldResumeInference(s as TrainTaskStatus)), 'pause 与 resume 逐态相反')

  // —— 推理互斥的开关本体（票 62）：置位/清除真的翻，ensure 真的让路 ——
  setInferenceHold(false)
  push('开关：初始未置位', !sovitsInferenceHeld(), `held=${sovitsInferenceHeld()}`)
  setInferenceHold(true)
  setInferenceHold(true)
  push('开关：重复置位仍是「已置位」（布尔，不叠计数）', sovitsInferenceHeld(), `held=${sovitsInferenceHeld()}`)
  // 注入端口/引擎包：探针不碰真实端口、不认领真实安装，真 spawn 只能在人工验收里发生。
  let ioCalls = 0
  const probeIo = {
    portOpen: async (): Promise<boolean> => {
      ioCalls += 1
      return false
    },
    home: (): string => {
      ioCalls += 1
      return join(app.getPath('temp'), 'omd2-train-probe-no-sovits-home')
    }
  }
  const logCount = (needle: string): number => sovitsServerLogs().filter((line) => line.includes(needle)).length
  const heldBefore = logCount('TTS_SOVITS_SERVER_HELD')
  const startBefore = logCount('TTS_SOVITS_SERVER_START')
  const heldEnsure = await ensureSovitsServer(probeIo)
  push('守住时 ensure 直接拒绝', heldEnsure === false, `ensure=${heldEnsure}`)
  push('守住时端口与引擎包都不查（更不会 spawn）', ioCalls === 0, `ioCalls=${ioCalls}`)
  push(
    '守住时留痕 TTS_SOVITS_SERVER_HELD，且没有启动尝试',
    logCount('TTS_SOVITS_SERVER_HELD') === heldBefore + 1 && logCount('TTS_SOVITS_SERVER_START') === startBefore,
    `held ${heldBefore}->${logCount('TTS_SOVITS_SERVER_HELD')} start ${startBefore}->${logCount('TTS_SOVITS_SERVER_START')}`
  )
  setInferenceHold(false)
  push('开关：一次清除即释放（重复置位不叠账）', !sovitsInferenceHeld(), `held=${sovitsInferenceHeld()}`)
  ioCalls = 0
  const releasedEnsure = await ensureSovitsServer(probeIo)
  push(
    '释放后回到原行为：照常查端口与引擎包（未安装 → false + install-not-found）',
    releasedEnsure === false && ioCalls === 2 && sovitsServerLogs().some((line) => line.includes('install-not-found')),
    `ensure=${releasedEnsure} ioCalls=${ioCalls}`
  )
  setInferenceHold(false)
  push('开关：重复清除仍是清除', !sovitsInferenceHeld(), `held=${sovitsInferenceHeld()}`)
  setInferenceHold(true)
  ioCalls = 0
  const reHeld = await ensureSovitsServer(probeIo)
  push('开关：再置位又拦住（释放不粘）', reHeld === false && ioCalls === 0, `ensure=${reHeld} ioCalls=${ioCalls}`)
  setInferenceHold(false)
  // 接线钉：任务生命周期要真 spawn 才走得到，纯缝探针只能钉 manager 里那两句还在。
  const wiring = managerHoldWiring()
  push(
    '接线钉：manager 开跑置位、退场清除两句都还在',
    !wiring.readable || (wiring.set && wiring.clear),
    wiring.readable ? `set=${wiring.set} clear=${wiring.clear}` : '源码不在（非源码运行），跳过'
  )
  const ledgerWiring = recordLedgerWiring()
  push(
    '接线钉：录音存盘那条路把录音落进账本（待训数字才会跟着涨）',
    !ledgerWiring.readable || ledgerWiring.wired,
    ledgerWiring.readable ? `wired=${ledgerWiring.wired}` : '源码不在（非源码运行），跳过'
  )

  // —— 计划推导 ——
  const demo = deriveTrainPlan({ kind: 'demo', dataset: '' })
  push('demo：node -e 跑内联脚本，可直接启动', demo.exe === 'node' && demo.args[0] === '-e' && !demo.unavailable, JSON.stringify({ exe: demo.exe, arg0: demo.args[0] }))
  push('demo 脚本带 epoch 行与 10 轮上限', demo.args.join(' ').includes('epoch ${i}/${n}') && demo.args.join(' ').includes('const n = 10'), '内联脚本内容')
  push('asr-ft：环境没附件就拒启动并说明原因', (deriveTrainPlan({ kind: 'asr-ft', dataset: '' }).unavailable ?? '').includes('环境没就绪'), deriveTrainPlan({ kind: 'asr-ft', dataset: '' }).unavailable ?? '')
  push(
    'gv-*：没 gvResolved 备料就拒启动并说明原因（T3 起是真训练，备料在主进程做）',
    (deriveTrainPlan({ kind: 'gv-gpt', dataset: '' }).unavailable ?? '').includes('没就绪') &&
      (deriveTrainPlan({ kind: 'gv-sovits', dataset: '' }).unavailable ?? '').includes('没就绪'),
    deriveTrainPlan({ kind: 'gv-gpt', dataset: '' }).unavailable ?? ''
  )
  push('乱值 kind 打回 demo', normalizeTrainKind('bogus') === 'demo' && normalizeTrainKind(42) === 'demo', `${String(normalizeTrainKind('bogus'))}/${String(normalizeTrainKind(42))}`)
  push('合法 kind 原样通过', normalizeTrainKind('gv-sovits') === 'gv-sovits', normalizeTrainKind('gv-sovits'))

  // —— asr-ft 真训练链（T5 闭环） ——
  const ftPaths: AsrFtPaths = {
    trainer: 'qwen3-sft',
    pythonExe: 'P:/ython.exe',
    sftScript: 'S/ft.py',
    exportScript: 'E/export.py',
    baseModelDir: 'M/base',
    baseModelId: ''
  }
  const ftData = { trainJsonl: 'T.jsonl', evalJsonl: 'V.jsonl', runDir: 'R' }
  const ftPlan = deriveTrainPlan({ kind: 'asr-ft', dataset: '', asrFt: { paths: ftPaths, data: ftData, exportDir: 'X' } })
  const epochAt = ftPlan.args.indexOf('--epochs')
  push('asr-ft：带环境附件出真命令（python + 冻结的试点参数）', ftPlan.exe === ftPaths.pythonExe && epochAt >= 0 && ftPlan.args[epochAt + 1] === '66' && !ftPlan.unavailable, ftPlan.args.join(' '))
  push(
    '自适应轮数：38 条→66 封顶、122→26、400→10 保底、99→32、0→66',
    deriveFtEpochs(38) === 66 && deriveFtEpochs(122) === 26 && deriveFtEpochs(400) === 10 && deriveFtEpochs(99) === 32 && deriveFtEpochs(0) === 66,
    [38, 122, 400, 99, 0].map((n) => deriveFtEpochs(n)).join('/')
  )
  const tuned = planAsrFtTrainArgv(ftPaths, ftData, { epochs: 26, lr: '1e-5', resumeFrom: 'R/checkpoint-660' })
  const flagValue = (argv: string[], flag: string): string => argv[argv.indexOf(flag) + 1] ?? ''
  push(
    'tuning 覆盖：--lr/--epochs/--resume_from 三对值都对',
    flagValue(tuned, '--lr') === '1e-5' && flagValue(tuned, '--epochs') === '26' && flagValue(tuned, '--resume_from') === 'R/checkpoint-660',
    tuned.join(' ')
  )
  push('默认 argv 不带 --resume_from（新开跑）', !ftPlan.args.includes('--resume_from'), ftPlan.args.join(' '))
  // —— 开训方式（T63）：从底模重训 / 接着上次权重 ——
  push(
    '开训方式归一：只认 incremental，其余（undefined / 乱值 / fresh）全部落回 fresh',
    normalizeAsrFtMode('incremental') === 'incremental' &&
      normalizeAsrFtMode('fresh') === 'fresh' &&
      normalizeAsrFtMode(undefined) === 'fresh' &&
      normalizeAsrFtMode('bogus') === 'fresh',
    ['incremental', 'fresh', String(normalizeAsrFtMode(undefined)), String(normalizeAsrFtMode(42))].join('/')
  )
  const funasrPaths: AsrFtPaths = { ...ftPaths, trainer: 'funasr-paraformer' }
  const incFunasr = planFtTuning({ mode: 'incremental', trainer: 'funasr-paraformer', trainCount: 40, initFrom: 'S/asr-models/paraformer-zh.next/model.pt.avg1' })
  const incQwen = planFtTuning({ mode: 'incremental', trainer: 'qwen3-sft', trainCount: 20, lastStep: 660, resumeFrom: 'S/asr-models/qwen3-asr.next/checkpoint-660' })
  const funasrArgv = planAsrFtTrainArgv(funasrPaths, ftData, incFunasr)
  const qwenArgv = planAsrFtTrainArgv(ftPaths, ftData, incQwen)
  const funasrInit = '++init_param=S/asr-models/paraformer-zh.next/model.pt.avg1'
  push(
    '增量 argv：funasr 拼 ++init_param=<副本权重>（紧跟 ++model）、qwen3 拼 --resume_from <副本 checkpoint>',
    funasrArgv.includes(funasrInit) &&
      funasrArgv.indexOf(funasrInit) === funasrArgv.findIndex((arg) => arg.startsWith('++model=')) + 1 &&
      flagValue(qwenArgv, '--resume_from') === 'S/asr-models/qwen3-asr.next/checkpoint-660' &&
      !qwenArgv.includes('++init_param') &&
      !funasrArgv.includes('--resume_from'),
    `${funasrInit} | ${flagValue(qwenArgv, '--resume_from')}`
  )
  push(
    '增量超参：funasr 轮数走 deriveFtIncrementalEpochs、lr 1e-5；qwen3 从 checkpoint 步数续算、lr 1e-5',
    incFunasr.epochs === deriveFtIncrementalEpochs(40) &&
      incFunasr.epochs === 8 &&
      incFunasr.lr === '1e-5' &&
      incFunasr.initFrom !== null &&
      incFunasr.resumeFrom === undefined &&
      incQwen.epochs === deriveFtResumeEpochs(20, 660) &&
      incQwen.lr === '1e-5' &&
      incQwen.resumeFrom !== null,
    `funasr:${incFunasr.epochs}轮/${incFunasr.lr} qwen:${incQwen.epochs}轮/${incQwen.lr}`
  )
  const freshQwen = planFtTuning({ mode: 'fresh', trainer: 'qwen3-sft', trainCount: 20, resumeFrom: '不应生效', initFrom: '不应生效' })
  const freshFunasr = planFtTuning({ mode: 'fresh', trainer: 'funasr-paraformer', trainCount: 20, resumeFrom: '不应生效', initFrom: '不应生效' })
  push(
    '重训与今天逐字相同：tuning 不接续点、argv 无 --resume_from / ++init_param、轮数与 lr 走默认',
    freshQwen.resumeFrom === undefined &&
      freshQwen.initFrom === undefined &&
      freshFunasr.resumeFrom === undefined &&
      freshFunasr.initFrom === undefined &&
      freshQwen.epochs === deriveFtEpochs(20) &&
      freshFunasr.lr === '0.0002' &&
      !planAsrFtTrainArgv(ftPaths, ftData, freshQwen).includes('--resume_from') &&
      !planAsrFtTrainArgv(funasrPaths, ftData, freshFunasr).includes('++init_param') &&
      !planAsrFtTrainArgv(ftPaths, ftData, {}).includes('--resume_from'),
    `qwen:${freshQwen.epochs}轮/${freshQwen.lr} funasr:${freshFunasr.epochs}轮/${freshFunasr.lr}`
  )
  // —— 开训估时（T65）：条数 × 轮数 × 每步耗时，全程纯乘法；量级必须对得上 docs/BENCH.md ——
  const estZero = estimateFtCost({ mode: 'fresh', trainer: 'qwen3-sft', takes: 0 })
  const estZeroFunasr = estimateFtCost({ mode: 'fresh', trainer: 'funasr-paraformer', takes: 0 })
  push(
    '开训估时：0 条不抛、步数与分钟都是 0，文案让人先录几条',
    estZero.steps === 0 &&
      estZero.minutes === 0 &&
      estZero.label.includes('先录几条') &&
      estZeroFunasr.steps === 0 &&
      estZeroFunasr.minutes === 0,
    `${estZero.label} | ${estZeroFunasr.label}`
  )
  const estOne = estimateFtCost({ mode: 'fresh', trainer: 'qwen3-sft', takes: 1 })
  const estOneFunasr = estimateFtCost({ mode: 'fresh', trainer: 'funasr-paraformer', takes: 1 })
  push(
    '开训估时：1 条也是有限量级（qwen3 66 步 / 6 分钟、paraformer 40 步 / 1 分钟），谁都不许除零',
    estOne.steps === 66 && estOne.minutes === 6 && estOneFunasr.steps === 40 && estOneFunasr.minutes === 1,
    `qwen3: ${estOne.label} | funasr: ${estOneFunasr.label}`
  )
  const estG14 = estimateFtCost({ mode: 'fresh', trainer: 'qwen3-sft', takes: 40, audioMs: 76_000 })
  const estG14Funasr = estimateFtCost({ mode: 'fresh', trainer: 'funasr-paraformer', takes: 40, audioMs: 76_000 })
  push(
    '开训估时对得上实测：G14 40 条 → qwen3 660 步 65 分钟（BENCH 实测 1:05:18）、paraformer 608 步 6 分钟（BENCH 约 6 分钟）',
    estG14.steps === 660 && Math.abs(estG14.minutes - 65) <= 1 && estG14Funasr.steps === 608 && estG14Funasr.minutes === 6,
    `qwen3: ${estG14.steps}步/${estG14.minutes}分 paraformer: ${estG14Funasr.steps}步/${estG14Funasr.minutes}分`
  )
  const estMany = estimateFtCost({ mode: 'fresh', trainer: 'qwen3-sft', takes: 400 })
  push(
    '开训估时：几百条不炸（400 条 → 1000 步 / 98 分钟），没有 NaN / Infinity',
    estMany.steps === 1000 && estMany.minutes === 98 && Number.isFinite(estMany.steps + estMany.minutes),
    estMany.label
  )
  const estIncQwen = estimateFtCost({ mode: 'incremental', trainer: 'qwen3-sft', takes: 40, lastStep: 660 })
  const estIncFunasr = estimateFtCost({ mode: 'incremental', trainer: 'funasr-paraformer', takes: 40, lastStep: 660 })
  push(
    '增量估时只报「这次还要跑多少」：qwen3 从 checkpoint-660 接着算 200 步 / 20 分钟；funasr 优化器重建，报整段 304 步 / 3 分钟',
    estIncQwen.steps === 200 && estIncQwen.minutes === 20 && estIncFunasr.steps === 304 && estIncFunasr.minutes === 3,
    `qwen3: ${estIncQwen.label} | funasr: ${estIncFunasr.label}`
  )
  const qwenCost = ftCostBasis('qwen3-sft')
  const funasrCost = ftCostBasis('funasr-paraformer')
  push(
    '每步耗时只有引擎表一份（qwen3 5.9 / paraformer 0.6 秒），估时文案自称「估算」并指向 docs/BENCH.md',
    qwenCost !== null &&
      qwenCost.secPerStep === 5.9 &&
      funasrCost !== null &&
      funasrCost.secPerStep === 0.6 &&
      estG14.label.includes('估算') &&
      estG14.basis.includes('docs/BENCH.md') &&
      estG14.label.includes('76 秒音频'),
    `qwen3:${qwenCost?.secPerStep} funasr:${funasrCost?.secPerStep} ｜ ${estG14.basis}`
  )
  push(
    '增量找权重：avg1 > best > model.pt；都没有就是 null（上层据此拒启动）',
    incrementalWeightFile(['model.pt.best', 'model.pt.avg1']) === 'model.pt.avg1' &&
      incrementalWeightFile(['model.pt', 'model.pt.best']) === 'model.pt.best' &&
      incrementalWeightFile(['model.pt']) === 'model.pt' &&
      incrementalWeightFile(['model.int8.onnx', 'tokens.txt']) === null,
    incrementalWeightFile(['model.int8.onnx', 'tokens.txt']) === null ? 'null' : 'wrong'
  )
  // 验证集作为标尺不能动：上一轮是 eval 的仍是 eval（同一个分数可以横着比），新录的句子只进训练集。
  const incSplit = splitIncrementalEval(
    [
      { key: 'G14-L01', wavPath: 'X:/1.wav', text: '一' },
      { key: 'G14-L02', wavPath: 'X:/2.wav', text: '二' },
      { key: 'G14-L05', wavPath: 'X:/5.wav', text: '五' }
    ],
    ['G14-L01']
  )
  const incSplitFresh = splitIncrementalEval(
    [
      { key: 'G14-L01', wavPath: 'X:/1.wav', text: '一' },
      { key: 'G14-L02', wavPath: 'X:/2.wav', text: '二' }
    ],
    []
  )
  push(
    '增量验证集沿用上一轮：旧 eval 留在 eval、新录的只进 train；没有上一轮 eval 就全进 train',
    incSplit.eval.map((entry) => entry.key).join(',') === 'G14-L01' &&
      incSplit.train.map((entry) => entry.key).join(',') === 'G14-L02,G14-L05' &&
      incSplitFresh.eval.length === 0 &&
      incSplitFresh.train.length === 2,
    `${incSplit.train.length}/${incSplit.eval.length} | ${incSplitFresh.train.length}/${incSplitFresh.eval.length}`
  )
  const fp = (key: string, bytes: number, mtime: number): FtLedgerEntry => ({ key, wavPath: `X:/${key}.wav`, bytes, mtimeMs: mtime, text: '', split: 'train' })
  const coverage = ftTrainCoverage([fp('G14-L01', 100, 1), fp('G14-L02', 200, 2)], [
    { key: 'G14-L01', bytes: 100, mtimeMs: 1 },
    { key: 'G14-L02', bytes: 201, mtimeMs: 2 },
    { key: 'G14-L05', bytes: 300, mtimeMs: 3 }
  ])
  push(
    '已训标记：指纹全等=done、变动=stale、账本没有=没训（都计 total）',
    coverage.G14.done === 1 && coverage.G14.stale === 1 && coverage.G14.total === 3,
    JSON.stringify(coverage)
  )
  push(
    '续训对账：逐条全等放行、一条重录拒绝、空账本拒绝',
    ftLedgerMatchedOnDisk([fp('G14-L01', 100, 1)], [{ key: 'G14-L01', bytes: 100, mtimeMs: 1 }]) &&
      !ftLedgerMatchedOnDisk([fp('G14-L01', 100, 1)], [{ key: 'G14-L01', bytes: 101, mtimeMs: 1 }]) &&
      !ftLedgerMatchedOnDisk([], [{ key: 'G14-L01', bytes: 100, mtimeMs: 1 }]),
    '三态判定'
  )
  push('续训轮数：checkpoint 660 + 补 200 步、每轮 5 步 → 172', deriveFtResumeEpochs(20, 660) === 172, String(deriveFtResumeEpochs(20, 660)))
  const apps = parseNvidiaComputeApps('1234, python.exe, 4096\n7, C:\\py, torch.exe, 512\nrubbish\n')
  push(
    'nvidia-smi compute-apps 解析：pid 首逗号、显存末逗号、中间当名字、垃圾行跳过',
    apps.length === 2 && apps[0].pid === 1234 && apps[0].usedMiB === 4096 && apps[1].name === 'C:\\py, torch.exe' && apps[1].usedMiB === 512,
    JSON.stringify(apps)
  )
  const okGpu = judgeFtVram({ totalMiB: 8188, usedMiB: 4488, apps: [{ pid: 9, name: 'api_v2.py', usedMiB: 3000 }], excludePids: [9] })
  const badGpu = judgeFtVram({ totalMiB: 8188, usedMiB: 7000, apps: [{ pid: 5, name: 'python.exe', usedMiB: 2000 }], excludePids: [] })
  push(
    '显存账：自家 GV 让路后够 6400；外部占 2000 判不够并点名（判定只出提示，不拦启动）',
    okGpu.ok && okGpu.holders.length === 0 && !badGpu.ok && badGpu.holders[0].includes('python.exe'),
    JSON.stringify({ okGpu, badGpu })
  )
  push('显存账带出空闲数：4488 已用 − GV 3000 → 6700；7000 已用 → 1188', okGpu.freeMiB === 6700 && badGpu.freeMiB === 1188, `${okGpu.freeMiB}/${badGpu.freeMiB}`)
  const naRows = parseNvidiaComputeApps('49992, python.exe, [N/A]\n1844, dwm.exe, [N/A]\n')
  const naNote = ftVramNote({ totalMiB: 8188, usedMiB: 6724, apps: naRows, excludePids: [49992] })
  push(
    '显存预检：WDDM 的 [N/A] 行被跳过，提示里没有 NaN 且给出整卡数字',
    naRows.length === 0 && naNote !== null && !naNote.includes('NaN') && naNote.includes('6724') && naNote.includes('8188'),
    naNote ?? 'null'
  )
  push(
    '显存预检不再拦启动：够用没提示；不够时明说「照常开跑」',
    ftVramNote({ totalMiB: 8188, usedMiB: 1000, apps: [] }) === null &&
      (ftVramNote({ totalMiB: 8188, usedMiB: 7000, apps: [] }) ?? '').includes('照常开跑'),
    String(ftVramNote({ totalMiB: 8188, usedMiB: 7000, apps: [] }))
  )
  // 回归：官方脚本 eval_strategy="steps" 无条件，空验证集会在 trainer 构造时 ValueError，
  // 所以两个 JSONL 都得有；缺哪个就报哪个，别只给「打包失败」四个字。
  const packOk = judgeFtDataset({ ok: true, trainPath: 'D:/d/train.jsonl', evalPath: 'D:/d/eval.jsonl', error: null })
  const packNoEval = judgeFtDataset({ ok: true, trainPath: 'D:/d/train.jsonl', evalPath: '', error: null })
  const packNoTrain = judgeFtDataset({ ok: true, trainPath: '', evalPath: 'D:/d/eval.jsonl', error: null })
  const packNoRecord = judgeFtDataset({ ok: false, trainPath: '', evalPath: '', error: '还没有已录的句子——先在上方录几条再打包' })
  push(
    '打包判据：两个 JSONL 缺一不可，失败原因逐条说清',
    packOk.ok === true &&
      !packNoEval.ok &&
      packNoEval.error.includes('验证集') &&
      !packNoTrain.ok &&
      packNoTrain.error.includes('训练集') &&
      !packNoRecord.ok &&
      packNoRecord.error.includes('还没有已录的句子'),
    JSON.stringify({ packOk, packNoEval, packNoTrain, packNoRecord })
  )
  const exportArgv = planAsrFtExportArgv(ftPaths, 'R/checkpoint-330', 'X')
  const deviceAt = exportArgv.indexOf('--device')
  push('导出腿：CPU 上跑并带自校验', deviceAt >= 0 && exportArgv[deviceAt + 1] === 'cpu' && exportArgv.includes('--verify'), exportArgv.join(' '))
  push('checkpoint 挑编号最大的', pickLastCheckpointName(['eval', 'checkpoint-150', 'checkpoint-330']) === 'checkpoint-330' && pickLastCheckpointName([]) === null && pickLastCheckpointName(['checkpoint-x']) === null, String(pickLastCheckpointName(['checkpoint-150', 'checkpoint-330'])))
  push('换模序列：删旧备份→现役进备份→next 转正', JSON.stringify(asrFtSwapSteps({ activeExists: true, bakExists: true, nextExists: true, exportExists: false })) === JSON.stringify(['rm-bak', 'bak-active', 'promote-next']), JSON.stringify(asrFtSwapSteps({ activeExists: false, bakExists: false, nextExists: true, exportExists: false })))
  // 回归：正常路径上 .next 还不存在，只有导出产物——旧实现只认 next，于是「导出成功点按钮」永远报没有新模型。
  push(
    '换模：只有导出产物（没有 next）也要组成序列',
    JSON.stringify(asrFtSwapSteps({ activeExists: true, bakExists: false, nextExists: false, exportExists: true })) === JSON.stringify(['bak-active', 'promote-next']),
    JSON.stringify(asrFtSwapSteps({ activeExists: true, bakExists: false, nextExists: false, exportExists: true }))
  )
  push('换模：没有导出产物也没有 next 才是空序列', asrFtSwapSteps({ activeExists: true, bakExists: true, nextExists: false, exportExists: false }).length === 0, '[]')
  // 回归：导出腿中途断掉时目录里已有 conv_frontend/encoder，缺 decoder.int8；
  // 那时点「应用新模型」会把残缺目录转正（识别 worker 静默死），必须逐件点名。
  push(
    '导出齐全判据：缺 decoder.int8 就不许应用，缺哪件报哪件',
    missingFtExportFiles(['conv_frontend.onnx', 'encoder.int8.onnx', 'decoder.int8.onnx']).length === 0 &&
      JSON.stringify(missingFtExportFiles(['conv_frontend.onnx', 'encoder.onnx', 'encoder.onnx.data'])) === '["encoder.int8.onnx","decoder.int8.onnx"]' &&
      missingFtExportFiles([]).length === 3,
    JSON.stringify(missingFtExportFiles(['conv_frontend.onnx', 'encoder.onnx', 'encoder.onnx.data']))
  )
  // 回归：换模槽位判据按引擎表的落位文件名查。写死 qwen3 的文件名会让 paraformer 一直「缺模型」。
  push(
    '槽位判据跟引擎表走：paraformer 认 model.int8 + tokens，qwen3 认三件 onnx',
    missingFtSlotFiles(['model.int8.onnx', 'tokens.txt'], 'paraformer').length === 0 &&
      JSON.stringify(missingFtSlotFiles(['model.int8.onnx'], 'paraformer')) === '["tokens.txt"]' &&
      missingFtSlotFiles(['conv_frontend.onnx', 'encoder.int8.onnx', 'decoder.int8.onnx'], 'qwen3').length === 0 &&
      JSON.stringify(missingFtSlotFiles([], 'paraformer')) === '["model.int8.onnx","tokens.txt"]',
    JSON.stringify(missingFtSlotFiles([], 'paraformer'))
  )
  push(
    '换模文案点名是哪次导出：带 run id / 不带 / 失败透传',
    ftAppliedNote({ ok: true, error: null, model: 'ft-20261107181058' }).includes('ft-20261107181058') &&
      ftAppliedNote({ ok: true, error: null }) === '新模型已转正，下一句识别就用它' &&
      ftAppliedNote({ ok: false, error: '导出没跑完' }) === '导出没跑完',
    ftAppliedNote({ ok: true, error: null, model: 'ft-20261107181058' })
  )
  push('回滚序列：有备份才动手', JSON.stringify(asrFtRollbackSteps({ bakExists: true })) === JSON.stringify(['rm-active', 'restore-bak']) && asrFtRollbackSteps({ bakExists: false }).length === 0, '')
  push('环境点名：全缺四项、全齐空数组', deriveAsrFtEnvGaps({}).length === 4 && deriveAsrFtEnvGaps({ venvOk: true, sftScript: 's', exportScript: 'e', baseModelDir: 'm' }).length === 0, String(deriveAsrFtEnvGaps({}).length))
  push('安装步骤：全缺五步、全齐空序列', JSON.stringify(planAsrFtInstallSteps({ scripts: false, uv: false, venv: false, deps: false, model: false })).includes('下载 uv') && planAsrFtInstallSteps({ scripts: true, uv: true, venv: true, deps: true, model: true }).length === 0, String(planAsrFtInstallSteps({ scripts: false, uv: true, venv: false, deps: true, model: true }).length))
  const uvHtml = '<a href="../../packages/aa/bb/uv-0.9.5-py3-none-win_amd64.whl#sha256=x">u</a><a href="../../packages/cc/dd/uv-0.10.2-py3-none-win_amd64.whl#sha256=y">u</a><a href="../../packages/ee/ff/uv-0.10.2-py3-none-macosx_11_0_arm64.whl">u</a>'
  const uvCands = uvWheelCandidates(uvHtml)
  push('uv 资产挑最新 win_amd64 wheel', pickLatestUvAsset([{ name: 'uv-0.9.5-py3-none-win_amd64.whl' }, { name: 'uv-0.10.2-py3-none-win_amd64.whl' }, { name: 'uv-0.10.2-py3-none-macosx_11_0_arm64.whl' }]) === 'uv-0.10.2-py3-none-win_amd64.whl' && pickLatestUvAsset([{ name: 'uv-installer.ps1' }]) === null, String(pickLatestUvAsset(uvCands)))
  push('uv 索引解析与链接改写', uvCands.length === 2 && pickLatestUvAsset(uvCands) === 'uv-0.10.2-py3-none-win_amd64.whl' && resolveUvWheelUrl('../../packages/cc/dd/uv-0.10.2-py3-none-win_amd64.whl#sha256=y', 'https://mirrors.aliyun.com/pypi/simple/uv/') === 'https://mirrors.aliyun.com/pypi/packages/cc/dd/uv-0.10.2-py3-none-win_amd64.whl' && resolveUvWheelUrl('https://files.pythonhosted.org/packages/cc/dd/uv-0.10.2-py3-none-win_amd64.whl#sha256=y') === 'https://mirrors.aliyun.com/pypi/packages/cc/dd/uv-0.10.2-py3-none-win_amd64.whl', resolveUvWheelUrl(uvCands[1].href))

  // —— 日志行 → 进度 ——
  const p = (line: string): string => JSON.stringify(parseTrainProgress(line))
  push('epoch 3/20 → 15%', JSON.stringify(parseTrainProgress('epoch 3/20')) === JSON.stringify({ percent: 15, stage: 'epoch 3/20' }), p('epoch 3/20'))
  push('Epoch 大小写不敏感', parseTrainProgress('Epoch 12/20')?.percent === 60, p('Epoch 12/20'))
  push('epoch 10/10 → 100%', parseTrainProgress('epoch 10/10')?.percent === 100, p('epoch 10/10'))
  push('epoch 0/0 → null（防除零）', parseTrainProgress('epoch 0/0') === null, p('epoch 0/0'))
  push('tqdm 进度条 → 直接取百分比', parseTrainProgress(' 45%|█████     | 210/500 [01:10<01:26]')?.percent === 45, p(' 45%|█████     | 210/500 [01:10<01:26]'))
  push('step 120/600 → 20%', parseTrainProgress('step 120/600')?.percent === 20, p('step 120/600'))
  push('裸百分比也认', parseTrainProgress('training 99% complete')?.percent === 99, p('training 99% complete'))
  push('epoch 分式优先于裸百分比', parseTrainProgress('epoch 1/2 50%')?.stage === 'epoch 1/2', p('epoch 1/2 50%'))
  push('普通日志行 → null（只进日志环）', parseTrainProgress('loss 0.42') === null && parseTrainProgress('loading dataset') === null, `${p('loss 0.42')}/${p('loading dataset')}`)
  push('空行/纯空白 → null', parseTrainProgress('') === null && parseTrainProgress('   ') === null, `${p('')}/${p('   ')}`)


  // —— 一键打包纯缝（#14：录音×稿子→官方 JSONL） ——
  const groups: FtDatasetGroupView[] = [
    { id: 'G15', mode: 'lines', lines: [{ no: 1, text: '中路二塔快没了。' }, { no: 2, text: '下路野区刷了两组野怪。' }, { no: 3, text: '河道的神符刷新了。' }] },
    { id: 'G21', mode: 'free', lines: [] }
  ]
  const built = buildFtDatasetEntries(
    groups,
    (group, line) => group === 'G15' && (line === 'L01' || line === 'L03'),
    (group, line) => `X:/rec/${group}-${line}.wav`
  )
  push('打包只收已录的逐句句', built.entries.length === 2 && built.entries[0].wavPath.includes('G15-L01') && built.notRecorded === 1, JSON.stringify(built))
  push('自由说组整组跳过（无标准答案）', built.entries.every((entry) => entry.wavPath.includes('G15')), JSON.stringify(built.entries.map((entry) => entry.wavPath)))
  const progress = buildFtGroupProgress(
    groups,
    (key) => (key === 'G15-L01' ? 1500 : key === 'G15-L03' ? 2300 : key.startsWith('G21-T') && !key.includes('T03') && Number(key.slice(-2)) <= 2 ? 800 : null)
  )
  push(
    '组进度：缺句报名、时长累加、free 组断链即止',
    progress[0].done === 2 && progress[0].total === 3 && progress[0].missing[0] === 2 && progress[0].durationMs === 3800 && progress[1].done === 2 && progress[1].total === 2 && progress[1].missing.length === 0,
    JSON.stringify(progress)
  )
  const jsonl = buildFtJsonlLine(built.entries[0])
  push('JSONL 行带 language Chinese 前缀', jsonl.includes('"audio":"X:/rec/G15-L01.wav"') && jsonl.includes('language Chinese<asr_text>中路二塔快没了。'), jsonl)
  const split = splitTrainEval(built.entries)
  push('两条起必切验证集（官方脚本 eval_strategy 无条件 steps）', split.train.length === 1 && split.eval.length === 1, `train=${split.train.length} eval=${split.eval.length}`)
  const splitOne = splitTrainEval(built.entries.slice(0, 1))
  push('只有一条时验证集留空（打包层会先拒）', splitOne.train.length === 1 && splitOne.eval.length === 0, `train=${splitOne.train.length} eval=${splitOne.eval.length}`)
  const splitBig = splitTrainEval([1, 2, 3, 4, 5].map((no) => ({ key: `G01-L${String(no).padStart(2, '0')}`, wavPath: `w${no}`, text: `t${no}` })))
  push('够量时尾部 2 条进验证', splitBig.train.length === 3 && splitBig.eval.length === 2 && splitBig.eval[0].wavPath === 'w4', `train=${splitBig.train.length} eval=${splitBig.eval.length}`)
  // —— 录音判定（T4a 录音面板）：开停/收尾/命名全在共享缝 ——
  const t0 = 1_000_000
  const st0 = initialRecordingState(t0)
  push(
    '初态：没说过话、静音未武装',
    !st0.speechSeen && st0.quietSince === 0 && st0.startedAt === t0,
    JSON.stringify(st0),
  )
  const stepQuiet = advanceRecording(st0, { rms: 0, nowMs: t0 + 500 })
  push(
    '没说过话：静多久都不武装、不停',
    !stepQuiet.stop && stepQuiet.state.quietSince === 0,
    JSON.stringify(stepQuiet.state),
  )
  const stepSpeak = advanceRecording(stepQuiet.state, { rms: RECORDING_LIMITS.rmsThreshold, nowMs: t0 + 510 })
  push('超阈值 → speechSeen 置位', stepSpeak.state.speechSeen && !stepSpeak.stop, JSON.stringify(stepSpeak.state))
  const stepArmed = advanceRecording(stepSpeak.state, { rms: 0, nowMs: t0 + 520 })
  push(
    '说完第一块安静样本 → 静音武装',
    stepArmed.state.quietSince === t0 + 520 && !stepArmed.stop,
    `quietSince=${stepArmed.state.quietSince}`,
  )
  const stepNotYet = advanceRecording(stepArmed.state, {
    rms: 0,
    nowMs: stepArmed.state.quietSince + RECORDING_LIMITS.quietMsToStop - 1,
  })
  push('静音不足 quietMsToStop → 不停', !stepNotYet.stop, `quietSince=${stepNotYet.state.quietSince}`)
  const stepFired = advanceRecording(stepArmed.state, {
    rms: 0,
    nowMs: stepArmed.state.quietSince + RECORDING_LIMITS.quietMsToStop,
  })
  push('静音满 quietMsToStop → 自动停', stepFired.stop && stepFired.reason === '自动停', `${stepFired.stop}/${stepFired.reason}`)
  const stepCap = advanceRecording(initialRecordingState(0), { rms: 0, nowMs: RECORDING_LIMITS.maxMs })
  push(
    `满 maxMs → 到 ${RECORDING_LIMITS.maxMs / 1000}s 上限停`,
    stepCap.stop && stepCap.reason === `到 ${RECORDING_LIMITS.maxMs / 1000}s 上限`,
    `${stepCap.stop}/${stepCap.reason}`,
  )
  const stepBoth = advanceRecording(stepArmed.state, {
    rms: 0,
    nowMs: stepArmed.state.quietSince + RECORDING_LIMITS.quietMsToStop + RECORDING_LIMITS.maxMs,
  })
  push('静音时限与上限同一步命中 → 先判中的（自动停）赢', stepBoth.stop && stepBoth.reason === '自动停', stepBoth.reason ?? '')
  const tooShort = shouldKeepTake({ durationMs: RECORDING_LIMITS.minMs - 1, speechSeen: true })
  push(
    'minMs-1 → 太短丢',
    !tooShort.keep && tooShort.reason === `太短（${RECORDING_LIMITS.minMs - 1}ms），丢弃了——重新点录制`,
    tooShort.reason ?? '',
  )
  const okTake = shouldKeepTake({ durationMs: RECORDING_LIMITS.minMs, speechSeen: true })
  push('minMs + 说过话 → 收', okTake.keep && okTake.reason === null, JSON.stringify(okTake))
  const silentTake = shouldKeepTake({ durationMs: RECORDING_LIMITS.minMs, speechSeen: false })
  push(
    '说过话=false → 静音段丢（哑麦样本不进数据集）',
    !silentTake.keep && silentTake.reason === '没检测到说话，丢弃——重新点录制',
    silentTake.reason ?? '',
  )
  const shortSilent = shouldKeepTake({ durationMs: RECORDING_LIMITS.minMs - 1, speechSeen: false })
  push('太短与静音同犯 → 时长判定在前', shortSilent.reason?.startsWith('太短') === true, shortSilent.reason ?? '')
  push(
    '段键：逐句 L、自由说 T，两位补零',
    takeLineId('lines', 3) === 'L03' && takeLineId('lines', 12) === 'L12' && takeLineId('free', 1) === 'T01',
    `${takeLineId('lines', 3)}/${takeLineId('lines', 12)}/${takeLineId('free', 1)}`,
  )
  const sampleKey = recordingKey('G01', 'lines', 3)
  push(
    '录音键 Gxx-Lnn / Gxx-Tnn，写盘白名单放行合法、拦下穿越',
    sampleKey === 'G01-L03' &&
      /^G\d{2}-(?:L|T)\d{2}$/.test(sampleKey) &&
      /^G\d{2}-(?:L|T)\d{2}$/.test(recordingKey('G01', 'free', 1)) &&
      (() => {
        try {
          parseRecordingKeyParts('../evil', 'L01/../x')
          return false
        } catch {
          return parseRecordingKeyParts('G15', 'T03').group === 'G15'
        }
      })(),
    sampleKey,
  )
  // —— 存完去哪一句（T6 录音舒适度）：只前进到没录过的行 ——
  const lineNext = nextUnrecordedLine({ lines: [1, 2, 3, 4], recorded: [1], current: 1 })
  push('存完第 1 句 → 落到第 2 句', lineNext === 2, String(lineNext))
  const lineSkip = nextUnrecordedLine({ lines: [1, 2, 3, 4], recorded: [1, 2, 3], current: 1 })
  push('跨过已录的行，落到下一条没录的', lineSkip === 4, String(lineSkip))
  const lineWrap = nextUnrecordedLine({ lines: [1, 2, 3, 4], recorded: [3, 4], current: 4 })
  push('末尾之后回绕到开头没录的', lineWrap === 1, String(lineWrap))
  const lineNeverSelf = nextUnrecordedLine({ lines: [1, 2], recorded: [], current: 2 })
  push('当前句不进候选（自动前进绝不原地/覆盖）', lineNeverSelf === 1, String(lineNeverSelf))
  const lineDone = nextUnrecordedLine({ lines: [1, 2, 3], recorded: [1, 2, 3], current: 3 })
  push('整组录完 → 不前进（null，面板停在原地）', lineDone === null, String(lineDone))
  const lineFree = nextUnrecordedLine({ lines: [], recorded: [], current: 1 })
  push('自由说组没有编号句 → 不前进', lineFree === null, String(lineFree))
  // 穷举 [1..4] 的每个 current × 每个已录子集：结果要么 null，要么既没录过也不是当前句。
  let lineInvariant = true
  const lineCandidates = [1, 2, 3, 4]
  for (const current of lineCandidates) {
    for (let mask = 0; mask < 16; mask += 1) {
      const recorded = lineCandidates.filter((no) => (mask & (1 << (no - 1))) !== 0)
      const next = nextUnrecordedLine({ lines: lineCandidates, recorded, current })
      if (next !== null && (recorded.includes(next) || next === current)) lineInvariant = false
      const pendingOthers = lineCandidates.filter((no) => no !== current && !recorded.includes(no)).length
      if ((next === null) !== (pendingOthers === 0)) lineInvariant = false
    }
  }
  push('64 种组合：自动前进永不落在已录行/当前句，null 当且仅当没有未录的句', lineInvariant, String(lineInvariant))
  // —— 推理互斥状态文案（T2 训练窗口的「为什么暂时没声」）——
  push(
    '互斥文案四态齐全',
    inferenceHoldLabel('held') === '推理已暂停（显存让给训练）' &&
      inferenceHoldLabel('kept-off').includes('未由应用托管') &&
      inferenceHoldLabel('released') === '推理已恢复' &&
      inferenceHoldLabel('release-failed').includes('恢复失败'),
    inferenceHoldLabel('held'),
  )
  // —— GV 微调（T3）：版本表 / 配置构造 / 备料验收 / 计划接线 ——
  const gvVersions = Object.keys(GV_VERSION_INFO)
  push(
    'GV 版本表六版齐全，缺省 v2ProPlus',
    gvVersions.length === 6 &&
      gvVersions.includes('v2ProPlus') &&
      normalizeGvVersion('v2') === 'v2' &&
      normalizeGvVersion('whatever') === GV_VERSION_DEFAULT,
    gvVersions.join(','),
  )
  const s2Built = buildS2TrainConfigData(
    { train: { batch_size: 4 }, data: { a: 1 }, model: { version: 'v2' } },
    {
      train: { version: 'v2ProPlus', batchSize: 8, epochs: 8 },
      expName: 'demo',
      pretrainedG: 'g.pth',
      pretrainedD: 'd.pth',
      sovitsWeightsRoot: 'SoVITS_weights_v2ProPlus'
    }
  )
  const s2Train = (s2Built?.train ?? null) as Record<string, unknown> | null
  push(
    's2 配置构造：批/轮/底模/实验目录/权重落点/版本全就位',
    !!s2Built &&
      !!s2Train &&
      s2Train['batch_size'] === 8 &&
      s2Train['epochs'] === 8 &&
      s2Train['pretrained_s2G'] === 'g.pth' &&
      s2Built['version'] === 'v2ProPlus' &&
      s2Built['s2_ckpt_dir'] === 'logs/demo' &&
      s2Built['save_weight_dir'] === 'SoVITS_weights_v2ProPlus' &&
      s2Built['name'] === 'demo',
    JSON.stringify(s2Built),
  )
  const s1Built = buildS1TrainConfigData(
    { train: { batch_size: 4, epochs: 20 } },
    { train: { version: 'v2ProPlus', batchSize: 8, epochs: 15 }, expName: 'demo', pretrainedS1: 's1.ckpt', gptWeightsRoot: 'GPT_weights_v2ProPlus' }
  )
  const s1Train = (s1Built?.train ?? null) as Record<string, unknown> | null
  push(
    's1 配置构造：批/轮/DPO/底模/三路径全就位',
    !!s1Built &&
      !!s1Train &&
      s1Train['batch_size'] === 8 &&
      s1Train['epochs'] === 15 &&
      s1Train['if_dpo'] === true &&
      s1Train['half_weights_save_dir'] === 'GPT_weights_v2ProPlus' &&
      s1Built['pretrained_s1'] === 's1.ckpt' &&
      s1Built['train_semantic_path'] === 'logs/demo/6-name2semantic.tsv' &&
      s1Built['train_phoneme_path'] === 'logs/demo/2-name2text.txt' &&
      s1Built['output_dir'] === 'logs/demo/logs_s1_v2ProPlus',
    JSON.stringify(s1Built),
  )
  push(
    '配置构造对缺节点模板回 null（引擎包不完整时拒写）',
    buildS2TrainConfigData({}, { train: { version: 'v2', batchSize: 8, epochs: 8 }, expName: 'x', pretrainedG: '', pretrainedD: '', sovitsWeightsRoot: '' }) === null &&
      buildS1TrainConfigData(null, { train: { version: 'v2', batchSize: 8, epochs: 8 }, expName: 'x', pretrainedS1: '', gptWeightsRoot: '' }) === null,
    'null-guard',
  )
  const allThere = judgeGvDataset({ expName: 'demo', phonemes: true, semantic: true, hubert: true, wav32k: true })
  const noSemantic = judgeGvDataset({ expName: 'demo', phonemes: true, semantic: false, hubert: true, wav32k: true })
  push(
    '备料验收：四件套齐 = 可开训，缺一件报名',
    allThere.ready && allThere.missing.length === 0 && !noSemantic.ready && noSemantic.missing.some((m) => m.includes('语义表')),
    `${allThere.missing.length} | ${noSemantic.missing.join(',')}`,
  )
  const gvBare = deriveTrainPlan({ kind: 'gv-sovits', dataset: 'demo' })
  const gvWired = deriveTrainPlan({
    kind: 'gv-gpt',
    dataset: 'demo',
    gvResolved: { home: 'H', pythonExe: 'P', configFile: 'C', expName: 'demo' }
  })
  push(
    'GV 计划：没备料拒启动；备好了 argv/cwd 全对（s1 用 --config_file）',
    gvBare.unavailable?.includes('没就绪') === true &&
      gvWired.unavailable === undefined &&
      gvWired.exe === 'P' &&
      JSON.stringify(gvWired.args) === JSON.stringify(['-s', 'GPT_SoVITS/s1_train.py', '--config_file', 'C']) &&
      gvWired.cwd === 'H',
    `${gvBare.unavailable ?? '-'} | ${gvWired.args.join(' ')}`,
  )
  const gvSovitsArgs = deriveTrainPlan({
    kind: 'gv-sovits',
    dataset: 'demo',
    gvResolved: { home: 'H', pythonExe: 'P', configFile: 'C', expName: 'demo' }
  })
  push(
    'GV s2 计划用 --config（非 GET 别名，照抄 webui）',
    JSON.stringify(gvSovitsArgs.args) === JSON.stringify(['-s', 'GPT_SoVITS/s2_train.py', '--config', 'C']),
    gvSovitsArgs.args.join(' '),
  )
  const sovitsLeg = GV_LEGS['gv-sovits']
  const gptLeg = GV_LEGS['gv-gpt']
  push(
    'GV 腿表是唯一真相：脚本/参数名/配置文件名/默认值同源',
    sovitsLeg.script === 'GPT_SoVITS/s2_train.py' &&
      sovitsLeg.configFlag === '--config' &&
      gptLeg.script === 'GPT_SoVITS/s1_train.py' &&
      gptLeg.configFlag === '--config_file' &&
      gptLeg.configFile === 'tmp_s1.yaml' &&
      sovitsLeg.configFile === 'tmp_s2.json' &&
      sovitsLeg.format === 'json' &&
      gptLeg.defaults.epochs === 15 &&
      sovitsLeg.templateFile(GV_VERSION_INFO.v2) === GV_VERSION_INFO.v2.s2ConfigTemplate &&
      gptLeg.requiredFiles(GV_VERSION_INFO.v2).includes(GV_VERSION_INFO.v2.s1Pretrained),
    `${sovitsLeg.script} | ${gptLeg.configFlag}`,
  )
  // —— 训练记录（run）：构建、收场、指标压缩 ——
  const started = buildTrainRun({ kind: 'asr-ft', experiment: '地图', startedAt: 1_700_000_000_000, data: { files: 40 } })
  push(
    'run 构建：id 带 kind 与时间戳，初始 running 且无终态',
    /^asr-ft-\d{14}$/.test(started.id) && started.status === 'running' && started.endedAt === null && started.data.files === 40 && started.data.bytes === 0,
    started.id,
  )
  const finished = finishTrainRun(started, { status: 'trained', endedAt: started.startedAt + 60_000, error: null })
  push(
    'run 收场：终态与结束时间写入，开始时间与 data 不动',
    finished.status === 'trained' && finished.endedAt === started.startedAt + 60_000 && finished.startedAt === started.startedAt && finished.data.files === 40,
    `${finished.status} ${finished.endedAt}`,
  )
  const longSeries = Array.from({ length: 1400 }, (_, i) => ({ step: i + 1, loss: 1 / (i + 1) }))
  const compacted = compactMetricSeries(longSeries)
  push(
    `指标压缩：1400 点压到 ${METRIC_SERIES_MAX}，首尾保住且单调不回头`,
    compacted.length === METRIC_SERIES_MAX &&
      compacted[0].step === 1 &&
      compacted[compacted.length - 1].step === 1400 &&
      compacted.every((p, i) => i === 0 || p.step > compacted[i - 1].step),
    `${compacted.length} / ${compacted[Math.floor(compacted.length / 2)].step}`,
  )
  const asrMetrics = parseAsrTrainerState({
    log_history: [
      { step: 10, epoch: 1, loss: 1.5, learning_rate: 0.00002 },
      { step: 20, epoch: 2, loss: 0.5, learning_rate: 0.00002 },
      { step: 20, eval_loss: 0.4 },
      { step: 30, epoch: 3, loss: 0.25, learning_rate: 0.00001 }
    ]
  })
  push(
    'ASR 指标：eval 行被忽略，best/last/steps/epochs 全对',
    asrMetrics !== null &&
      asrMetrics.steps === 30 &&
      asrMetrics.epochs === 3 &&
      asrMetrics.bestLoss === 0.25 &&
      asrMetrics.lastLoss === 0.25 &&
      asrMetrics.series.length === 3,
    JSON.stringify(asrMetrics && { steps: asrMetrics.steps, best: asrMetrics.bestLoss, n: asrMetrics.series.length }),
  )
  push('ASR 指标：没有 log_history 返回 null（不编空曲线）', parseAsrTrainerState({}) === null, '{}')
  const gvLog = ['====> Epoch: 1', 'saving ckpt mirana_e1:Success.', '====> Epoch: 2', 'saving ckpt mirana_e8:Success.'].join('\n')
  const gvParsed = parseGvTrainLog(gvLog)
  push(
    'GV 日志：epoch 时间线与 checkpoint 名单都提取',
    gvParsed.epochs === 2 && gvParsed.checkpoints.join(',') === 'mirana_e1,mirana_e8' && gvParsed.series.length === 2,
    `${gvParsed.epochs} | ${gvParsed.checkpoints.join(',')}`,
  )
  const newer = buildTrainRun({ kind: 'gv-sovits', experiment: 'mirana', startedAt: started.startedAt + 60_000 })
  push(
    'run 排序：新的在前',
    [started, newer].sort(compareRunsDesc)[0].id === newer.id,
    `${started.id} vs ${newer.id}`,
  )
  // 开训体检：缺环境/没录音必须 block；录音太少只 warn；增量接不上也必须 block（绝不静默重训）。
  const blocked = judgeAsrPreflight({
    env: { ok: false, gaps: ['torch'] },
    recordedLines: 0,
    packed: null,
    activeModel: false,
    mode: 'fresh',
    incrementalAvailable: false,
    vramNote: null
  })
  push(
    '体检：缺环境阻断',
    preflightBlocks(blocked).map((item) => item.id).join(',') === 'env,rec,model',
    preflightBlocks(blocked).map((item) => item.id).join(',')
  )
  const healthy = judgeAsrPreflight({
    env: { ok: true, gaps: [] },
    recordedLines: 4,
    packed: { train: 3, eval: 1 },
    activeModel: true,
    mode: 'fresh',
    incrementalAvailable: false,
    vramNote: '6GB 显卡建议批大小 1'
  })
  push(
    '体检：数据少只告警',
    preflightBlocks(healthy).length === 0 && healthy.some((item) => item.id === 'rec' && item.level === 'warn'),
    healthy.map((item) => `${item.id}:${item.level}`).join(' ')
  )
  const incReady = judgeAsrPreflight({
    env: { ok: true, gaps: [] },
    recordedLines: 4,
    packed: { train: 3, eval: 1 },
    activeModel: true,
    mode: 'incremental',
    incrementalAvailable: true,
    vramNote: null
  })
  const incMissing = judgeAsrPreflight({
    env: { ok: true, gaps: [] },
    recordedLines: 4,
    packed: { train: 3, eval: 1 },
    activeModel: true,
    mode: 'incremental',
    incrementalAvailable: false,
    vramNote: null
  })
  const freshAvailable = judgeAsrPreflight({
    env: { ok: true, gaps: [] },
    recordedLines: 4,
    packed: { train: 3, eval: 1 },
    activeModel: true,
    mode: 'fresh',
    incrementalAvailable: true,
    vramNote: null
  })
  push(
    '体检：增量可接=ok、接不上=block（点名没有可接的上一轮权重）；选了重训但有上一轮只提示可走增量',
    preflightBlocks(incReady).length === 0 &&
      preflightBlocks(incMissing).map((item) => item.id).join(',') === 'incremental' &&
      (incMissing.find((item) => item.id === 'incremental')?.detail ?? '').includes('没有可接的上一轮权重') &&
      preflightBlocks(freshAvailable).length === 0 &&
      (freshAvailable.find((item) => item.id === 'incremental')?.detail ?? '').includes('接着上次权重'),
    `${incReady.find((item) => item.id === 'incremental')?.level}/${incMissing.find((item) => item.id === 'incremental')?.level}/fresh+has:${freshAvailable.find((item) => item.id === 'incremental')?.level}`
  )
  const gv = judgeGvPreflight({ expName: 'mirana', missing: ['音素表 2-name2text.txt'], gptTrained: false, sovitsTrained: false })
  push('体检：GV 缺备料阻断', preflightBlocks(gv).map((item) => item.id).join(',') === 'data', gv.map((item) => `${item.id}:${item.level}`).join(' '))
  storeCases()

  // —— 读稿来源（#61）：数据目录的自定义稿优先，缺失/坏了才回落到随包自带的 ——
  const bundledMd = '## G01 日常\n1. 今天天气不错。\n2. 我中午吃了碗面。\n'
  const userMd = '## G14 对线\n1. 我没大，还在冷却。\n'
  const dataPath = 'data/asr-ft-script.md'
  const bundledPath = 'resources/asr-ft-script.md'
  const fromData = resolveFtScript({ path: dataPath, markdown: userMd }, { path: bundledPath, markdown: bundledMd })
  push(
    '读稿：数据目录有自定义稿就用它（组与句都跟着走）',
    fromData.source === 'data' &&
      fromData.groups.map((group) => group.id).join(',') === 'G14' &&
      fromData.groups[0].lines[0]?.text === '我没大，还在冷却。' &&
      fromData.warning === null &&
      fromData.path === dataPath,
    `${fromData.source} | ${fromData.groups.map((group) => group.id).join(',')} | ${fromData.path}`,
  )
  const noData = resolveFtScript({ path: dataPath, markdown: null }, { path: bundledPath, markdown: bundledMd })
  push(
    '读稿：数据目录没有自定义稿就回落自带，且不算告警',
    noData.source === 'bundled' &&
      noData.groups[0]?.id === 'G01' &&
      noData.groups[0].lines.length === 2 &&
      noData.warning === null &&
      noData.error === null,
    `${noData.source} | ${noData.groups.length} 组 | ${noData.path}`,
  )
  const brokenData = resolveFtScript(
    { path: dataPath, markdown: '这是随手写的一行，没有组标题也没有编号句\n' },
    { path: bundledPath, markdown: bundledMd },
  )
  push(
    '读稿：数据目录的稿子解析不了 → 回落自带并给告警',
    brokenData.source === 'bundled' &&
      brokenData.groups[0]?.id === 'G01' &&
      brokenData.warning !== null &&
      brokenData.error === null,
    brokenData.warning ?? '(没有告警)',
  )
  const mojibake = resolveFtScript(
    { path: dataPath, markdown: '## G01 日常\n1. 我没\uFFFD\uFFFD，还在冷却。\n' },
    { path: bundledPath, markdown: bundledMd },
  )
  push(
    '读稿：非 UTF-8 的稿子也回落（别拿乱码去录）',
    mojibake.source === 'bundled' && mojibake.groups[0]?.id === 'G01' && mojibake.warning !== null,
    mojibake.warning ?? '(没有告警)',
  )
  const noScript = resolveFtScript({ path: dataPath, markdown: '## 空\n' }, { path: bundledPath, markdown: null })
  push(
    '读稿：两份都没有/都坏才 error，并点名缺失的自带稿路径',
    noScript.groups.length === 0 && (noScript.error ?? '').includes(bundledPath),
    noScript.error ?? '(没有错误)',
  )
  const keyScript = resolveFtScript({ path: dataPath, markdown: userMd }, { path: bundledPath, markdown: bundledMd })
  push(
    '录音键 → 稿子正文：G14-L01 取到第一句，自由说/不存在/别组的键返回 null',
    scriptTextForKey(keyScript.groups, 'G14-L01') === '我没大，还在冷却。' &&
      scriptTextForKey(keyScript.groups, 'G14-T01') === null &&
      scriptTextForKey(keyScript.groups, 'G14-L09') === null &&
      scriptTextForKey(keyScript.groups, 'G99-L01') === null,
    `${scriptTextForKey(keyScript.groups, 'G14-L01')} / ${scriptTextForKey(keyScript.groups, 'G14-T01')}`,
  )
  let failed = 0
  for (const item of cases) {
    if (!item.ok) failed++
    console.log(`${item.ok ? 'PASS' : 'FAIL'} | ${item.name} | ${item.detail}`)
  }
  console.log(`TRAIN_PROBE ${cases.length - failed}/${cases.length} PASS`)
  app.exit(failed > 0 ? 1 : 0)
}

/**
 * #59 存储层：训练记录 + 数据集账本对着一个临时库跑，data/ 里的真库一个字节都不碰。
 * 迁移用例现造旧目录（train-runs/*.json + asr-ft-runs/<目录>/dataset.jsonl），导两次验幂等。
 */
function storeCases(): void {
  const root = mkdtempSync(join(tmpdir(), 'omd2-train-store-'))
  try {
    useTrainDatabase(join(root, 'db', 'runs.db'))
    push(
      '存储：一份库文件在 userData/train/runs.db',
      trainDbPath().replace(/\\/g, '/').endsWith('/train/runs.db'),
      trainDbPath()
    )
    push('存储：空库没有记录', listTrainRuns().length === 0 && listDatasetEntries().length === 0, `${listTrainRuns().length}/${listDatasetEntries().length}`)

    const base = Date.UTC(2026, 0, 1, 0, 0, 0)
    const runAt = (offsetMs: number): TrainRunRecord =>
      buildTrainRun({
        kind: 'asr-ft',
        experiment: `ft-${offsetMs}`,
        params: { batchSize: 1, epochs: 3, lr: '2e-5', resumeFrom: null },
        data: { files: 2, durationMs: 5000, bytes: 2048 },
        artifacts: { runDir: join(root, 'asr-ft-runs', `ft-${offsetMs}`), exportDir: join(root, 'onnx', `ft-${offsetMs}`) },
        startedAt: base + offsetMs
      })
    // 三条：收场成功（带指标）、失败（带原因）、还在跑。
    const oldest = finishTrainRun(runAt(0), {
      status: 'trained',
      endedAt: base + 1000,
      metrics: { steps: 12, epochs: 3, bestLoss: 0.5, lastLoss: 0.7, series: [{ step: 4, epoch: 1, loss: 0.9 }, { step: 12, epoch: 3, loss: 0.7 }] }
    })
    const middle = finishTrainRun(runAt(1000), { status: 'failed', error: 'exit 1', endedAt: base + 2000 })
    const newest = runAt(2000)
    for (const run of [oldest, middle, newest]) saveTrainRun(run)
    push(
      '存储：列表最新在前',
      listTrainRuns().map((run) => run.id).join('|') === [newest.id, middle.id, oldest.id].join('|'),
      listTrainRuns().map((run) => run.id).join(' ')
    )
    const back = loadTrainRun(oldest.id)
    const sameShape = back !== null && JSON.stringify(back) === JSON.stringify(oldest)
    push(
      '存储：读一条 = 写进去的形状（参数/指标/产物全在）',
      sameShape && back.metrics?.series.length === 2,
      sameShape ? `${back.id} ${back.status} steps=${back.metrics?.steps}` : `read=${JSON.stringify(back).slice(0, 300)}`
    )
    const patched = patchTrainRun(middle.id, (run) => ({ ...run, applied: true }))
    push('存储：改一条（转正标记）', patched?.applied === true && loadTrainRun(middle.id)?.applied === true, `applied=${patched?.applied}`)

    const pruned = pruneTrainRuns(2)
    push(
      '存储：超上限裁掉最旧的',
      pruned === 1 && listTrainRuns().length === 2 && loadTrainRun(oldest.id) === null,
      `pruned=${pruned} left=${listTrainRuns().length}`
    )

    const wav = (key: string, bytes: number, mtimeMs: number, text: string, split: 'train' | 'eval'): FtLedgerEntry => ({
      key,
      wavPath: join(root, 'asr-ft', `${key}.wav`),
      bytes,
      mtimeMs,
      text,
      split
    })
    // —— 待训数据（#64）：账本里 run_id 为空的最新修订 = 录了但没被任何一次 run 吃过的录音 ——
    const take = (key: string, seconds: number, text: string): FtLedgerEntry => ({
      key,
      wavPath: join(root, 'asr-ft', `${key}.wav`),
      bytes: 44 + seconds * 32000,
      mtimeMs: seconds,
      text,
      split: 'train'
    })
    saveDatasetLedger([take('G20-L01', 1, '第一句'), take('G20-L02', 2, '第二句')])
    const fresh = summarizePendingTakes({ entries: listDatasetEntries(), hasRun: false })
    push(
      '待训：没有历史 = 「从未训练过」，条数 = 最新修订里 run_id 为空的',
      fresh.count === 2 && !fresh.trained && !fresh.prompt && fresh.label.includes('从未训练过') && fresh.label.includes('2'),
      fresh.label
    )
    push(
      '待训：时长按 wav 字节折算（16k/16bit：44 字节头 + 32 字节/毫秒）',
      fresh.durationMs === 3000 && ftWavDurationMs(44 + 32000) === 1000,
      `${fresh.durationMs}ms`
    )
    recordDatasetTake(take('G20-L03', 0.5, '第三句'))
    const recorded = summarizePendingTakes({ entries: listDatasetEntries(), hasRun: false })
    push(
      '待训：录一条就落账（run_id 空）→ 条数和时长都涨',
      recorded.count === 3 && recorded.durationMs === 3500,
      `${recorded.count} 条 ${recorded.durationMs}ms`
    )
    markDatasetEntryTrained('G20-L01', 1, 'run-64')
    markDatasetEntryTrained('G20-L02', 1, 'run-64')
    const afterRun = summarizePendingTakes({ entries: listDatasetEntries(), hasRun: true })
    push(
      '待训：跑完一次 → 训过的清零，只剩没训的，文案换成「上次训练后」',
      afterRun.count === 1 &&
        afterRun.trained &&
        afterRun.durationMs === 500 &&
        afterRun.label.includes('上次训练后') &&
        !afterRun.prompt,
      afterRun.label
    )
    saveDatasetLedger([take('G20-L01', 1.2, '第一句')])
    const redoTake = summarizePendingTakes({ entries: listDatasetEntries(), hasRun: true })
    push(
      '待训：重录已训的一行不算新（同 key 同稿 = 同修订，run_id 保留）',
      redoTake.count === 1,
      `${redoTake.count} 条`
    )
    saveDatasetLedger([take('G20-L01', 1.2, '第一句（改稿）')])
    const relabeled = summarizePendingTakes({ entries: listDatasetEntries(), hasRun: true })
    push(
      '待训：同一行改过稿 = 新修订 → 算新',
      relabeled.count === 2 && relabeled.durationMs === 1700,
      `${relabeled.count} 条 ${relabeled.durationMs}ms`
    )
    // 三处同一个库：待训 + 已训（都只看最新修订）= 账本最新修订总数。
    const latestRevision = new Map<string, number>()
    for (const entry of listDatasetEntries()) latestRevision.set(entry.key, Math.max(latestRevision.get(entry.key) ?? 0, entry.revision))
    const latestRows = listDatasetEntries().filter((entry) => latestRevision.get(entry.key) === entry.revision)
    const trainedLatest = latestRows.filter((entry) => entry.runId !== null).length
    push(
      '待训：数字 = 最新修订 − 已训的最新修订（run 记录与账本同一个库，三处不会漂）',
      relabeled.count + trainedLatest === latestRows.length && latestRows.length === latestRevision.size,
      `待训 ${relabeled.count} + 已训 ${trainedLatest} = ${latestRows.length}`
    )
    const thresholdRow = (index: number) => ({ ...take(`G30-L${String(index).padStart(2, '0')}`, 0, '凑数'), revision: 1, runId: null })
    const belowThreshold = summarizePendingTakes({
      entries: Array.from({ length: FT_PENDING_PROMPT_AT - 1 }, (_, index) => thresholdRow(index + 1)),
      hasRun: true
    })
    const atThreshold = summarizePendingTakes({
      entries: Array.from({ length: FT_PENDING_PROMPT_AT }, (_, index) => thresholdRow(index + 1)),
      hasRun: true
    })
    push(
      `待训：够 ${FT_PENDING_PROMPT_AT} 条才变提示（${FT_PENDING_PROMPT_AT - 1} 条不算），而且只是提示不开训`,
      !belowThreshold.prompt &&
        atThreshold.prompt &&
        atThreshold.count === FT_PENDING_PROMPT_AT &&
        atThreshold.label.includes('再训'),
      `${belowThreshold.count}/${atThreshold.count} ${atThreshold.label}`
    )
    push(
      '待训：同一 key 的旧修订不重复计（只看最新修订）',
      summarizePendingTakes({
        entries: [1, 2, 3].map((revision) => ({ ...take('G40-L01', 1, '同一句'), revision, runId: null })),
        hasRun: false
      }).count === 1,
      'rev1..3 → 1 条'
    )
    forgetDatasetTake('G20-L03')
    const afterDelete = summarizePendingTakes({ entries: listDatasetEntries(), hasRun: true })
    push(
      '待训：删掉一条录音 → 未训的账本行一起删（数字不指着不存在的 wav），已训历史留着',
      afterDelete.count === 1 && findDatasetEntry('G20-L03') === null && findDatasetEntry('G20-L01', 1)?.runId === 'run-64',
      `${afterDelete.count} 条`
    )

    const g14Rows = (): ReturnType<typeof listDatasetEntries> => listDatasetEntries().filter((entry) => entry.key.startsWith('G14'))
    saveDatasetLedger([wav('G14-L01', 100, 1, '第一句', 'train'), wav('G14-L02', 200, 2, '第二句', 'eval')])
    push('账本：打包记账写入两条', g14Rows().length === 2, g14Rows().map((entry) => entry.key).join(' '))
    saveDatasetLedger([wav('G14-L01', 120, 5, '第一句', 'train'), wav('G14-L02', 200, 2, '第二句', 'train')])
    const reRecorded = findDatasetEntry('G14-L01')
    const evalKept = findDatasetEntry('G14-L02')
    push(
      '账本：重录同一句还是同一个修订，验证集划分不被重打包挪走',
      reRecorded?.revision === 1 && reRecorded.bytes === 120 && evalKept?.split === 'eval',
      `rev=${reRecorded?.revision} bytes=${reRecorded?.bytes} split=${evalKept?.split}`
    )
    saveDatasetLedger([wav('G14-L01', 120, 5, '第一句（改稿）', 'train')])
    const corrected = findDatasetEntry('G14-L01')
    push(
      '账本：改过稿件 = 新修订（旧修订留着）',
      corrected?.revision === 2 && corrected.runId === null && g14Rows().length === 3,
      `rev=${corrected?.revision} rows=${g14Rows().length}`
    )
    const g14Trained = (): number => g14Rows().filter((entry) => entry.runId !== null).length
    push('账本：没训过的条目 run_id 为空', g14Trained() === 0, `${g14Trained()}`)
    const marked = markDatasetEntryTrained('G14-L02', 1, newest.id)
    push(
      '账本：标记已训（run_id 落行）',
      marked && findDatasetEntry('G14-L02')?.runId === newest.id && g14Trained() === 1,
      `runId=${findDatasetEntry('G14-L02')?.runId} trained=${g14Trained()}`
    )
    saveDatasetLedger([wav('G14-L01', 120, 5, '第一句（改稿）', 'train')], newest.id)
    const snapshot = packedLedgerForRun(newest.id)
    push(
      '账本：开训留打包快照，失败的 run 也能续训对账',
      snapshot?.map((entry) => `${entry.key}/${entry.bytes}`).join(',') === 'G14-L01/120' &&
        findDatasetEntry('G14-L01')?.runId === null,
      `snapshot=${snapshot?.length ?? 'null'} runId=${findDatasetEntry('G14-L01')?.runId}`
    )

    // —— 迁移：旧版散文件（只读归档）——
    const legacyRunsDir = join(root, 'legacy', 'train-runs')
    const legacyAsrRoot = join(root, 'legacy', 'asr-ft-runs')
    const legacyRunDir = join(legacyAsrRoot, 'ft-20260101000000')
    mkdirSync(legacyRunsDir, { recursive: true })
    mkdirSync(legacyRunDir, { recursive: true })
    const legacyRun = finishTrainRun(
      buildTrainRun({
        kind: 'asr-ft',
        experiment: '',
        data: { files: 1, durationMs: 1000, bytes: 10 },
        artifacts: { runDir: legacyRunDir },
        startedAt: base - 60000
      }),
      { status: 'trained' }
    )
    writeFileSync(join(legacyRunsDir, `${legacyRun.id}.json`), JSON.stringify(legacyRun), 'utf8')
    writeFileSync(
      join(legacyRunDir, 'dataset.jsonl'),
      `${JSON.stringify({ key: 'G01-L01', wavPath: join(legacyRunDir, 'G01-L01.wav'), bytes: 10, mtimeMs: 1, text: '旧句', split: 'train' })}\n`,
      'utf8'
    )
    const runsBefore = listTrainRuns().length
    const entriesBefore = listDatasetEntries().length
    const firstImport = importLegacyTrainData({ runsDir: legacyRunsDir, asrRunsDir: legacyAsrRoot })
    const imported = findDatasetEntry('G01-L01')
    const importedSnapshot = packedLedgerForRun(legacyRun.id)
    push(
      '迁移：旧 run 与账本进库，条目挂到那次 run',
      !firstImport.skipped &&
        listTrainRuns().length === runsBefore + 1 &&
        listDatasetEntries().length === entriesBefore + 1 &&
        imported?.runId === legacyRun.id &&
        importedSnapshot?.map((entry) => entry.key).join(',') === 'G01-L01' &&
        loadTrainRun(legacyRun.id) !== null,
      `runs=${firstImport.runs} entries=${firstImport.entries} runId=${imported?.runId} snap=${importedSnapshot?.length ?? 'null'}`
    )
    const secondImport = importLegacyTrainData({ runsDir: legacyRunsDir, asrRunsDir: legacyAsrRoot })
    push(
      '迁移：同一批旧文件再导一次，一行都不多',
      secondImport.runs === 0 &&
        secondImport.entries === 0 &&
        listTrainRuns().length === runsBefore + 1 &&
        listDatasetEntries().length === entriesBefore + 1,
      `runs=${secondImport.runs} entries=${secondImport.entries} total=${listTrainRuns().length}/${listDatasetEntries().length}`
    )
    push(
      '迁移：旧文件原样留着（只读归档）',
      readdirSync(legacyRunDir).join(',') === 'dataset.jsonl' && existsSync(join(legacyRunsDir, `${legacyRun.id}.json`)),
      readdirSync(legacyRunDir).join(',')
    )

    const total = listTrainRuns().length
    const totalEntries = listDatasetEntries().length
    closeTrainStore()
    push(
      '存储：关掉重新打开，记录还在（真落盘）',
      listTrainRuns().length === total && listDatasetEntries().length === totalEntries && loadTrainRun(legacyRun.id) !== null,
      `${listTrainRuns().length}/${total}`
    )

    // —— 增量起点（T63）：找上一轮权重、沿用验证集、落盘副本；任何一步接不上都必须拒启动 ——
    useTrainDatabase(join(root, 'db-inc', 'runs.db'))
    const incLedger = (bytes: number): FtLedgerEntry[] => [
      wav('G14-L01', bytes, 1, '第一句', 'train'),
      wav('G14-L02', 200, 2, '第二句', 'eval')
    ]
    const emptySrc = findIncrementalSource(incLedger(100), 'funasr-paraformer')
    push(
      '增量：库是空的 → 拒启动并点名先做一次「从底模重训」',
      !emptySrc.ok && emptySrc.error.includes('还没有任何一轮训练记录'),
      emptySrc.ok ? 'found' : emptySrc.error
    )
    const incRunDir = join(root, 'asr-ft-runs-inc', 'ft-1')
    mkdirSync(incRunDir, { recursive: true })
    writeFileSync(join(incRunDir, 'model.pt.avg1'), 'weights-avg1', 'utf8')
    writeFileSync(join(incRunDir, 'model.pt'), 'weights-last', 'utf8')
    const incRun = buildTrainRun({
      kind: 'asr-ft',
      experiment: 'ft-inc',
      params: { batchSize: 1, epochs: 8, lr: '1e-5', resumeFrom: null, mode: 'incremental' },
      data: { files: 2, durationMs: 4000, bytes: 2048 },
      artifacts: { runDir: incRunDir, exportDir: join(root, 'onnx-inc') },
      startedAt: base + 5000
    })
    saveTrainRun(incRun)
    saveDatasetLedger(incLedger(100), incRun.id)
    const found = findIncrementalSource(incLedger(100), 'funasr-paraformer')
    push(
      '增量：账本全等 + 有 avg1 → 接 avg1，验证集沿用上一轮那份 eval',
      found.ok && found.source.artifact === 'model.pt.avg1' && found.source.evalKeys.join(',') === 'G14-L02',
      found.ok ? `${found.source.artifact} eval=${found.source.evalKeys.join(',')}` : found.error
    )
    push(
      '增量：开训口径落进 run 记录（params.mode）',
      loadTrainRun(incRun.id)?.params.mode === 'incremental',
      String(loadTrainRun(incRun.id)?.params.mode)
    )
    const stagedDir = join(root, 'asr-models', 'paraformer-zh.next')
    const staged = found.ok ? stageIncrementalSource(found.source, stagedDir) : null
    const stagedFile = join(stagedDir, 'model.pt.avg1')
    push(
      '增量：开训前先抄一份到 <引擎>.next，内容与原件逐字节相同（训练只读副本）',
      staged !== null && staged.ok && existsSync(stagedFile) && readFileSync(stagedFile, 'utf8') === readFileSync(join(incRunDir, 'model.pt.avg1'), 'utf8'),
      staged?.ok ? staged.stagedPath : staged?.error ?? 'no source'
    )
    const stagedArgv = planAsrFtTrainArgv(
      { trainer: 'funasr-paraformer', pythonExe: 'P/python.exe', sftScript: 'S/ft.py', exportScript: 'E/export.py', baseModelDir: 'M/base', baseModelId: 'paraformer-zh' },
      { trainJsonl: join(root, 'T.jsonl'), evalJsonl: join(root, 'V.jsonl'), runDir: join(root, 'asr-ft-runs-inc', 'ft-3') },
      planFtTuning({ mode: 'incremental', trainer: 'funasr-paraformer', trainCount: 2, initFrom: staged?.ok ? staged.stagedPath : null })
    )
    push(
      '增量：拼出的 argv 指的是那份副本，不是上一轮目录里的原件',
      staged?.ok === true && stagedArgv.includes(`++init_param=${staged.stagedPath}`),
      stagedArgv.find((arg) => arg.startsWith('++init_param=')) ?? 'no init_param'
    )
    const drifted = findIncrementalSource(incLedger(101), 'funasr-paraformer')
    push(
      '增量：重录过（指纹变了）→ 拒启动，绝不把旧错带进新权重',
      !drifted.ok && drifted.error.includes('对不上'),
      drifted.ok ? 'found' : drifted.error
    )
    rmSync(join(incRunDir, 'model.pt.avg1'), { force: true })
    rmSync(join(incRunDir, 'model.pt'), { force: true })
    const gone = findIncrementalSource(incLedger(100), 'funasr-paraformer')
    push(
      '增量：账本对得上但权重被删 → 拒启动，点名找过的文件名',
      !gone.ok && gone.error.includes('权重文件不在了'),
      gone.ok ? 'found' : gone.error
    )
    const missingCopy = stageIncrementalSource(
      { runDir: incRunDir, artifact: 'model.pt.avg1', lastStep: 0, evalKeys: [] },
      join(root, 'asr-models', 'paraformer-zh.bak')
    )
    push(
      '增量：副本源头不在了 → 拒启动并给出路径（开训前就报，不会跑到一半才发现）',
      !missingCopy.ok && missingCopy.error.includes('要接的权重不在了'),
      missingCopy.ok ? 'copied' : missingCopy.error
    )
    // qwen3 那条腿：接的是 checkpoint 目录，步数从目录名读，轮数从步数续算。
    const qRunDir = join(root, 'asr-ft-runs-inc', 'ft-2')
    mkdirSync(join(qRunDir, 'checkpoint-660'), { recursive: true })
    writeFileSync(join(qRunDir, 'checkpoint-660', 'trainer_state.json'), '{}', 'utf8')
    const qRun = buildTrainRun({
      kind: 'asr-ft',
      experiment: 'ft-inc-q',
      params: { batchSize: 1, epochs: 30, lr: '1e-5', resumeFrom: null, mode: 'incremental' },
      data: { files: 2, durationMs: 4000, bytes: 2048 },
      artifacts: { runDir: qRunDir, exportDir: join(root, 'onnx-inc-q') },
      startedAt: base + 6000
    })
    saveTrainRun(qRun)
    saveDatasetLedger(incLedger(100), qRun.id)
    const qFound = findIncrementalSource(incLedger(100), 'qwen3-sft')
    push(
      '增量：qwen3 接最新 checkpoint 目录并读出步数（660），funasr 不会去认 checkpoint',
      qFound.ok && qFound.source.artifact === 'checkpoint-660' && qFound.source.lastStep === 660,
      qFound.ok ? `${qFound.source.artifact}@${qFound.source.lastStep}` : qFound.error
    )
  } finally {
    closeTrainStore()
    rmSync(root, { recursive: true, force: true })
  }
}
