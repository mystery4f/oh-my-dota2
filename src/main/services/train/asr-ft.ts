import { app } from 'electron'
import { errorMessage } from '@shared/errors'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import {
  asrFtRollbackSteps,
  asrFtSwapSteps,
  deriveAsrFtEnvGaps,
  incrementalWeightFile,
  planAsrFtExportArgv,
  planFtTuning,
  pickLastCheckpointName,
  type AsrFtMode,
  type AsrFtPaths,
  type AsrFtFacts,
  type AsrFtStatusResult,
  type AsrFtSwapResult,
  type AsrFtTrainTuning,
  type AsrFtTrainer,

  type FtLedgerEntry,
  type FtRunMeta,
  ftVramNote,
  judgeFtDataset,
  missingFtExportFiles,
  ftLedgerMatchedOnDisk,
  ftTrainCoverage,
  parseNvidiaComputeApps,
  ftArtifactTargets,
  missingFtSlotFiles,
  summarizePendingTakes,
  estimateFtCost,
  ftWavDurationMs,
} from '@shared/train/asr-ft'
import type { TrainPlan, TrainStartRequest } from '@shared/train/task'
import { loadSettings } from '../settings'
import { activeAsrModel } from '../voice/asr-model'
import { locateWorkerScript } from '../voice/runtime'
import { resetSherpaWorker } from '../voice/sherpa-asr'
import { currentFtLedger, prepareFtDataset } from './ft-dataset'
import { ftRecList } from './ft-record'
import { asrRunDirsRoot, listDatasetEntries, listTrainRuns, packedLedgerForRun, trainedDatasetEntries } from './run-store'
import { sovitsChildPid } from '../voice/sovits-server'
import { ASR_ENGINE_LIST, type AsrEngineId, type AsrEngineSpec } from '@shared/asr/engines'

/**
 * ASR 微调闭环（T5）的环境与换模：
 * 环境认两种目录布局——应用内安装的规范布局（venv/sft/export/models）和手动搭的
 * 开发布局（试点那套 env/ + Qwen3-ASR/ + Qwen3-ASR-onnx/），settings.asrFtEnvDir
 * 指根目录，空则用应用数据目录里的 asr-ft-env。
 * 换模走「转正舞蹈」：导出产物 → qwen3-asr.next，旧 qwen3-asr 挪进 .bak，next 转正；
 * 出问题一键回滚。动模型前把常驻 sherpa worker 杀掉，下一次转写用新目录重新拉起。
 */

interface AsrFtLayout {
  pythonExe: string
  sftScript: string
  exportScript: string
  baseModelDir: string
}

export function asrFtEnvRoot(): string {
  return loadSettings().asrFtEnvDir.trim() || join(app.getPath('userData'), 'asr-ft-env')
}

/**
 * 微调腿挂在哪个引擎上：先看现役模型所属的引擎（它有 finetune 时），否则表里第一个声明 finetune 的引擎。
 * 必须跟着现役走——否则面板显示现役 paraformer、权重却写进 qwen3 的目录。
 */
function finetuneEngine(): AsrEngineSpec {
  const active = activeAsrModel()
  const spec = active ? ASR_ENGINE_LIST.find((item) => item.id === active.engineId) : undefined
  if (spec?.finetune != null) return spec
  const fallback = ASR_ENGINE_LIST.find((item) => item.finetune !== null)
  if (fallback === undefined) throw new Error('引擎表里没有任何引擎声明 finetune')
  return fallback
}

function finetuneSpec(): NonNullable<AsrEngineSpec['finetune']> {
  return finetuneEngine().finetune as NonNullable<AsrEngineSpec['finetune']>
}

/**
 * 脚本路径全部来自引擎表（应用内布局在前，手动开发布局在后）。
 * 以前这里抄了一遍 `sft/qwen3_asr_sft.py` 之类的字面量，换引擎时两处会打架。
 */
function layoutCandidates(root: string): AsrFtLayout[] {
  const finetune = finetuneSpec()
  return finetune.trainScripts.map((trainScript, index) => ({
    pythonExe: join(root, 'venv', 'Scripts', 'python.exe'),
    sftScript: join(root, trainScript),
    exportScript: join(root, finetune.exportScripts[index] ?? finetune.exportScripts[0]),
    baseModelDir: join(root, finetune.baseModelDirs[0])
  })).concat(
    finetune.trainScripts.map((trainScript, index) => ({
      // 手动开发布局：uv 环境 + 官方仓库 + 导出仓库克隆，python 在 env/ 而不是 venv/
      pythonExe: join(root, 'env', 'Scripts', 'python.exe'),
      sftScript: join(root, trainScript),
      exportScript: join(root, finetune.exportScripts[index] ?? finetune.exportScripts[0]),
      baseModelDir: join(root, finetune.baseModelDirs[0])
    }))
  )
}

/** 按布局探环境：sft 脚本出现在哪套布局就认哪套；啥都没有就按规范布局报缺。 */
export function detectAsrFtEnv(): { ok: boolean; gaps: string[]; paths: Partial<AsrFtPaths>; envRoot: string } {
  const envRoot = asrFtEnvRoot()
  const finetune = finetuneSpec()
  if (finetune.trainer === 'funasr-paraformer') {
    // funasr 走 `python -m`：没有要检测的脚本，只要一个装得下 funasr 的解释器（手动开发布局在前）。
    const pythonExe =
      [join(envRoot, 'env', 'Scripts', 'python.exe'), join(envRoot, 'venv', 'Scripts', 'python.exe')].find((path) =>
        existsSync(path)
      ) ?? ''
    const paths: Partial<AsrFtPaths> = {
      trainer: finetune.trainer,
      pythonExe,
      sftScript: '',
      exportScript: '',
      baseModelDir: '',
      baseModelId: finetune.baseModelIds[0] ?? ''
    }
    const gaps = deriveAsrFtEnvGaps({ ...paths, venvOk: Boolean(pythonExe) })
    return { ok: gaps.length === 0, gaps, paths, envRoot }
  }
  const picked = layoutCandidates(envRoot).find((layout) => existsSync(layout.sftScript)) ?? layoutCandidates(envRoot)[0]
  const paths: Partial<AsrFtPaths> = {
    trainer: finetune.trainer,
    pythonExe: existsSync(picked.pythonExe) ? picked.pythonExe : '',
    sftScript: existsSync(picked.sftScript) ? picked.sftScript : '',
    exportScript: existsSync(picked.exportScript) ? picked.exportScript : '',
    baseModelDir: existsSync(join(picked.baseModelDir, 'model.safetensors')) ? picked.baseModelDir : '',
    baseModelId: ''
  }
  const gaps = deriveAsrFtEnvGaps({ ...paths, venvOk: Boolean(paths.pythonExe) })
  return { ok: gaps.length === 0, gaps, paths, envRoot }
}

function asrModelsRoot(): string {
  return join(app.getPath('userData'), 'asr-models')
}

/** 微调腿的现役模型目录：跟着 finetuneEngine 走（userData 相对路径）。 */
function activeRel(): string {
  return finetuneEngine().canonicalRel
}

function activeDir(): string {
  return join(app.getPath('userData'), activeRel())
}

/**
 * 对讲下载的官方模型（voice-runtime/models/qwen3-asr）。第一次换模时 asr-models 还不存在，
 * 词表只能从这里借——微调不动词表，借来仍是同一份。
 */
function shippedModelDir(): string {
  return join(app.getPath('userData'), 'voice-runtime', 'models', basename(activeRel()))
}

function backupDir(): string {
  return join(asrModelsRoot(), `${basename(activeRel())}.bak`)
}

function stagingDir(): string {
  return join(asrModelsRoot(), `${basename(activeRel())}.next`)
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/**
 * 一个换模槽位算不算「备齐」：按现役引擎的产物清单逐件查。
 * 写死 decoder.int8.onnx 是 qwen3 的旧习惯——paraformer 的产物叫 model.int8.onnx + tokens.txt，
 * 用旧判据会让面板一直显示「缺模型」。
 */
function slotReady(dir: string, engineId: AsrEngineId): boolean {
  const files = ftArtifactTargets(engineId)
  return files.length > 0 && missingFtSlotFiles(safeReaddir(dir), engineId).length === 0
}

/** 导出产物目录：asr-ft-onnx/ 下最新一个产物齐全的（就是链式导出写出来的那个）。 */
function lastExportDir(engineId: AsrEngineId): string | null {
  const root = join(app.getPath('userData'), 'asr-ft-onnx')
  const entries = safeReaddir(root)
    .filter((name) => slotReady(join(root, name), engineId))
    .sort()
  return entries.length > 0 ? join(root, entries[entries.length - 1]) : null
}


/** 换模四态的同步视图：asrFtStatus（含已训标记，异步）和 applyAsrFtModel（同步）共用。 */
function swapView(): AsrFtStatusResult['swap'] {
  const engineId = finetuneEngine().id
  return {
    activeExists: slotReady(activeDir(), engineId),
    bakExists: slotReady(backupDir(), engineId),
    nextExists: slotReady(stagingDir(), engineId),
    lastExportDir: lastExportDir(engineId)
  }
}
/** python 包体检：只查 finetune.pythonExtra 点名的包，结果按解释器路径缓存（换环境后重启生效）。 */
let pythonExtraCache: { pythonExe: string; packages: string; missing: string[] } | null = null

function missingPythonPackages(pythonExe: string, packages: readonly string[]): string[] {
  const key = packages.join(',')
  if (packages.length === 0 || pythonExe === '') return []
  if (pythonExtraCache?.pythonExe === pythonExe && pythonExtraCache.packages === key) {
    return pythonExtraCache.missing
  }
  const probe = `import importlib.util as u, json; print(json.dumps([m for m in ${JSON.stringify(packages)} if u.find_spec(m) is None]))`
  const done = spawnSync(pythonExe, ['-c', probe], { timeout: 30000, windowsHide: true, encoding: 'utf8' })
  if (done.status !== 0) return []
  let missing: string[] = []
  try {
    const parsed: unknown = JSON.parse(String(done.stdout).trim().split(/\r?\n/).pop() ?? '[]')
    if (Array.isArray(parsed)) missing = parsed.map((item) => String(item))
  } catch {
    missing = []
  }
  pythonExtraCache = { pythonExe, packages: key, missing }
  return missing
}
/** 环境检测 + 换模视图 + 已训标记（coverage）；安装进行时由 ipc 层补（install 字段），避免和安装器互相 import。 */
export async function asrFtStatus(): Promise<Omit<AsrFtStatusResult, 'install'>> {
  const env = detectAsrFtEnv()
  const missing = missingPythonPackages(env.paths.pythonExe ?? '', finetuneSpec().pythonExtra)
  const gaps = missing.length > 0 ? [...env.gaps, `python 包缺 ${missing.join('、')}（在 ${env.envRoot} 里 pip install）`] : env.gaps
  const engine = finetuneEngine()
  const trainer = env.paths.trainer ?? 'qwen3-sft'
  // 估时（#65）：条数 / 时长取当前账本，续训起点取与开训闸门同一判据（接不上的那轮不算）。
  const ledger = await currentFtLedger()
  const source = findIncrementalSource(ledger, trainer)
  // 增量的验证集不是默认尾部 holdout，而是上一轮 run 的 evalKeys（开训时 prepareFtDataset 就按它重打包）：
  // 估时要用同一份切分，否则上一轮只留 1 条验证时步数会少算一条数据。
  const evalKeys = source.ok ? new Set(source.source.evalKeys) : null
  const incrementalEvalTakes = evalKeys === null ? undefined : ledger.filter((entry) => evalKeys.has(entry.key)).length
  const costInput = {
    trainer,
    takes: ledger.length,
    audioMs: ledger.reduce((sum, entry) => sum + ftWavDurationMs(entry.bytes), 0),
    lastStep: source.ok ? source.source.lastStep : 0
  }
  const estimate = {
    fresh: estimateFtCost({ ...costInput, mode: 'fresh' }),
    incremental: estimateFtCost({ ...costInput, mode: 'incremental', evalTakes: incrementalEvalTakes })
  }
  return {
    env: { ok: gaps.length === 0, gaps, envRoot: env.envRoot },
    target: {
      engineId: engine.id,
      label: engine.label,
      trainer,
      modelDir: join(app.getPath('userData'), engine.canonicalRel),
      baseModel: env.paths.baseModelId || env.paths.baseModelDir || ''
    },
    swap: swapView(),
    // 覆盖标记只认「被某次 run 真正吃过」的条目：库里 run_id 非空的就是。（打包过但没训的不算。）
    coverage: ftTrainCoverage(trainedDatasetEntries(), await ftRecList()),
    // 待训数据：账本里最新修订但 run_id 为空的那些（录了还没训），条数与时长都从账本推。
    pending: summarizePendingTakes({
      entries: listDatasetEntries(),
      hasRun: listTrainRuns().some((run) => run.kind === 'asr-ft')
    }),
    estimate,
    estimateBasis: estimate.fresh.basis
  }
}

/**
 * tokenizer/ 目录兜底：导出产物只含三个 onnx，sherpa 加载还要 vocab.json / merges.txt /
 * tokenizer_config.json（微调没动词表，逐文件从备份或原始模型目录借）。
 * 任何一件哪都没有 = 'no-source'，调用方报错——缺词表的模型目录只会让 worker 静默死。
 */
function ensureTokenizerFiles(into: string, fallbackDirs: string[]): string | null {
  const dir = join(into, 'tokenizer')
  for (const f of ['tokenizer_config.json', 'vocab.json', 'merges.txt']) {
    const target = join(dir, f)
    if (existsSync(target)) continue
    let borrowed = false
    for (const src of fallbackDirs) {
      const source = join(src, 'tokenizer', f)
      if (existsSync(source)) {
        mkdirSync(dir, { recursive: true })
        cpSync(source, target)
        borrowed = true
        break
      }
    }
    if (!borrowed) return 'no-source'
  }
  return null
}

export function applyAsrFtModel(): AsrFtSwapResult {
  const swap = swapView()
  // 正常路径上 .next 根本不存在（它只在 promote-next 里现拷现改名），所以判据是「有导出产物」。
  const steps = asrFtSwapSteps({ ...swap, exportExists: Boolean(swap.lastExportDir) })
  if (steps.length === 0) {
    return { ok: false, error: '没有可应用的新模型：先跑一次训练，等「导出 ONNX」完成再点' }
  }
  // 导出腿中途断掉时目录里已经有 conv_frontend/encoder，唯独缺 decoder.int8——
  // 那时转正会让识别 worker 加载失败，所以先点名缺件，不碰现役模型。
  if (swap.lastExportDir) {
    const missing = missingFtExportFiles(safeReaddir(swap.lastExportDir))
    if (missing.length > 0) {
      return { ok: false, error: `导出没跑完（缺 ${missing.join('、')}）：重新点一次「开始训练」，等导出完成再应用` }
    }
  }
  const active = activeDir()
  const bak = backupDir()
  const next = stagingDir()
  try {
    for (const op of steps) {
      if (op === 'rm-bak') rmSync(bak, { recursive: true, force: true })
      if (op === 'bak-active') renameSync(active, bak)
      if (op === 'promote-next') {
        // 只拷 sherpa 加载的三件 int8（+ 词表）：导出目录里还躺着 3–5 GB 的 fp32 外置分片，
        // 整盘转正会让现役目录翻几倍，下一轮换模又得再拷一遍。
        if (swap.lastExportDir) {
          rmSync(next, { recursive: true, force: true })
          mkdirSync(next, { recursive: true })
          // 产物映射来自引擎表：qwen3 是三件 onnx 原样搬，paraformer 要把 model_quant.onnx 改名成 model.int8.onnx。
          const finetune = finetuneSpec()
          for (const artifact of finetune.artifacts) {
            cpSync(join(swap.lastExportDir, artifact.from), join(next, artifact.to))
          }
          // 兜底顺序：刚进备份的上一版 → asr-models 下任何目录 → 对讲下载的官方模型。
          const fallbacks = [bak, ...safeReaddir(asrModelsRoot()).map((d) => join(asrModelsRoot(), d)), shippedModelDir()]
          // 借件：导出目录里没有、sherpa 又要的文件（qwen3 的 tokenizer/、paraformer 的 tokens.txt）。
          for (const item of finetune.borrow) {
            const target = join(next, item.path)
            if (existsSync(target)) continue
            const source = fallbacks.map((dir) => join(dir, item.path)).find((path) => existsSync(path))
            if (source === undefined) {
              throw new Error(`导出产物缺 ${item.path}，备份和原始模型目录里也没得借`)
            }
            cpSync(source, target, { recursive: item.recursive === true })
          }
          // qwen3 的词表是三件齐用，逐件再兜一层（借目录只能整目录借，缺一件就是坏目录）。
          const needsTokenizer = finetune.borrow.some((item) => item.path === 'tokenizer')
          if (needsTokenizer && ensureTokenizerFiles(next, fallbacks) === 'no-source') {
            throw new Error('导出产物缺 tokenizer 词表文件，备份和原始模型目录里也没得借')
          }
        }
        renameSync(next, active)
      }
    }
  } catch (err) {
    return { ok: false, error: `换模失败：${errorMessage(err)}（模型目录可能停在中间态，按「回滚上一版」恢复）` }
  }
  markAppliedForExport(swap.lastExportDir ?? '')
  resetSherpaWorker()
  return { ok: true, error: null, model: swap.lastExportDir ? basename(swap.lastExportDir) : null }
}

function runsRoot(): string {
  return asrRunDirsRoot()
}

function readRunMeta(runDir: string): FtRunMeta | null {
  try {
    return JSON.parse(readFileSync(join(runDir, 'run.json'), 'utf8')) as FtRunMeta
  } catch {
    return null
  }
}

function writeRunMeta(runDir: string, meta: FtRunMeta): void {
  writeFileSync(join(runDir, 'run.json'), JSON.stringify(meta, null, 2), 'utf8')
}

/** run.json 缺了（老 run / 磁盘问题）就静默跳过——记账不能反过来挡训练。 */
/** 供 manager 失败收场回写（账本状态只前进不回退；run.json 缺了就跳过）。 */
export function markRunStatus(runDir: string, status: FtRunMeta['status'], patch?: Partial<FtRunMeta>): void {
  const meta = readRunMeta(runDir)
  if (!meta) return
  writeRunMeta(runDir, { ...meta, ...patch, status, finishedAt: status === 'running' ? null : Date.now() })
}

/** 转正后回写：找 exportDir 对上的那次 run 标 applied；找不到（老 run 没账本）就跳过。 */
function markAppliedForExport(exportDir: string): void {
  if (!exportDir) return
  for (const name of safeReaddir(runsRoot())) {
    const runDir = join(runsRoot(), name)
    const meta = readRunMeta(runDir)
    if (meta?.exportDir === exportDir) markRunStatus(runDir, 'applied', { applied: true })
  }
}

/** 增量微调的接续点：上一轮 run 的目录、磁盘上真实存在的权重，以及它那份验证集。 */
export interface IncrementalSource {
  runDir: string
  /** funasr：权重文件名（model.pt.avg1 / .best / model.pt）；qwen3：checkpoint 目录名。 */
  artifact: string
  /** qwen3 的 checkpoint 步数（funasr 走 init_param，用不到，给 0）。 */
  lastStep: number
  /** 上一轮打包时的验证集 key：增量沿用这份标尺，新录的句子只进训练集。 */
  evalKeys: string[]
}

/**
 * 增量起点：最新一轮「账本对得上」的 run，且磁盘上真有能接的权重。
 * 对不上就点名拒绝——增量静默落回全新训练，等于把「补训几分钟」变成「底模重训一小时」。
 * 对账口径与 asrFtFacts 同一份：旧数据只增不改（重录/删掉就接不上）。
 */
export function findIncrementalSource(
  currentLedger: readonly FtLedgerEntry[],
  trainer: AsrFtTrainer
): { ok: true; source: IncrementalSource } | { ok: false; error: string } {
  let sawRun = false
  let sawMatched = false
  for (const run of listTrainRuns()) {
    const runDir = run.artifacts.runDir
    if (typeof runDir !== 'string' || runDir.length === 0) continue
    sawRun = true
    const packed = packedLedgerForRun(run.id)
    if (packed === null || !ftLedgerMatchedOnDisk(packed, currentLedger)) continue
    sawMatched = true
    const names = safeReaddir(runDir)
    const evalKeys = packed.filter((entry) => entry.split === 'eval').map((entry) => entry.key)
    if (trainer === 'funasr-paraformer') {
      const weight = incrementalWeightFile(names)
      if (!weight) continue
      return { ok: true, source: { runDir, artifact: weight, lastStep: 0, evalKeys } }
    }
    const checkpoint = pickLastCheckpointName(names)
    if (!checkpoint) continue
    return {
      ok: true,
      source: { runDir, artifact: checkpoint, lastStep: Number(checkpoint.slice('checkpoint-'.length)), evalKeys }
    }
  }
  if (!sawRun) {
    return { ok: false, error: '增量微调要从上一轮的权重接着跑，但还没有任何一轮训练记录——先做一次「从底模重训」' }
  }
  if (!sawMatched) {
    return { ok: false, error: '上一轮的录音和现在对不上（有重录或删除）：增量会把旧错带进新权重——先做一次「从底模重训」' }
  }
  return {
    ok: false,
    error:
      trainer === 'funasr-paraformer'
        ? '上一轮的权重文件不在了（找过 model.pt.avg1 / model.pt.best / model.pt）：没法接着训，先做一次「从底模重训」'
        : '上一轮的 checkpoint 不在了（训练目录里没有 checkpoint-<步数>）：没法接着训，先做一次「从底模重训」'
  }
}

/**
 * 接续点落盘：把上一轮的权重抄进 `<asr-models>/<engine>.next` 再拼训练命令。
 * 训练只读这份副本（funasr 的 init_param 会按它重建优化器，qwen3 的 resume_from 会读 trainer_state）——
 * 副本烂了、训练失败了，都碰不到现役权重和上一轮的产物。
 */
export function stageIncrementalSource(
  source: IncrementalSource,
  staging: string
): { ok: true; stagedPath: string } | { ok: false; error: string } {
  const from = join(source.runDir, source.artifact)
  const to = join(staging, source.artifact)
  try {
    if (!existsSync(from)) return { ok: false, error: `要接的权重不在了：${from}` }
    rmSync(to, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    cpSync(from, to, { recursive: statSync(from).isDirectory() })
    return { ok: true, stagedPath: to }
  } catch (err) {
    return { ok: false, error: `复制接续权重失败：${errorMessage(err)}` }
  }
}

/** 开训闸门看到的两件事实：显存提示，以及上一轮的权重是否真的能接（与 resolveAsrFtTrainRequest 同一判据）。 */
export async function asrFtFacts(): Promise<AsrFtFacts> {
  const found = findIncrementalSource(await currentFtLedger(), finetuneSpec().trainer)
  return { vramNote: ftVramGuard(), incremental: found.ok }
}

/**
 * 显存预检：nvidia-smi 在就量一次，查不到（无 N 卡 / 不在 PATH）静默跳过。
 * 只回提示不回拒绝：Windows 的 WDDM 不暴露每进程显存（used_memory 全是 [N/A]），
 * 自家 GV 的占用既扣不掉、也点不出名字，硬闸在本机只会永远判不过。
 */
function ftVramGuard(): string | null {
  const q = spawnSync('nvidia-smi', ['--query-gpu=memory.total,memory.used', '--format=csv,noheader,nounits'], { timeout: 5000, windowsHide: true })
  if (q.error || q.status !== 0) return null
  const [totalMiB, usedMiB] = String(q.stdout).trim().split(',').map((n) => Number(n.trim()))
  if (!Number.isFinite(totalMiB) || !Number.isFinite(usedMiB)) return null
  const raw = spawnSync('nvidia-smi', ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits'], { timeout: 5000, windowsHide: true })
  const apps = raw.error || raw.status !== 0 ? [] : parseNvidiaComputeApps(String(raw.stdout))
  const ownPid = sovitsChildPid()
  return ftVramNote({ totalMiB, usedMiB, apps, excludePids: ownPid ? [ownPid] : [] })
}

export function rollbackAsrFtModel(): AsrFtSwapResult {
  const steps = asrFtRollbackSteps({ bakExists: slotReady(backupDir(), finetuneEngine().id) })
  if (steps.length === 0) {
    return { ok: false, error: '没有备份可回滚：应用过一次新模型之后才有' }
  }
  const active = activeDir()
  const bak = backupDir()
  try {
    for (const op of steps) {
      if (op === 'rm-active') rmSync(active, { recursive: true, force: true })
      if (op === 'restore-bak') renameSync(bak, active)
    }
  } catch (err) {
    return { ok: false, error: `回滚失败：${errorMessage(err)}` }
  }
  resetSherpaWorker()
  return { ok: true, error: null }
}

/** 训练启动前把环境、数据、目录备齐：缺一样就拒启动；显存只给提示（warning），不拦。 */
export async function resolveAsrFtTrainRequest(mode: AsrFtMode): Promise<{
  ok: boolean
  request?: TrainStartRequest
  error?: string
  warning?: string | null
}> {
  const env = detectAsrFtEnv()
  if (!env.ok || !env.paths.pythonExe) {
    return { ok: false, error: `微调环境没就绪：${env.gaps.join('；')}` }
  }
  const missingPkgs = missingPythonPackages(env.paths.pythonExe, finetuneSpec().pythonExtra)
  if (missingPkgs.length > 0) {
    return { ok: false, error: `训练环境缺 python 包：${missingPkgs.join('、')}（在 ${env.envRoot} 里 pip install）` }
  }
  const vramNote = ftVramGuard()
  // 先按现有录音打包：数据本身不可训（不足两条 / 文件丢了）时先报那个错，别拿「没有上一轮」掩盖它。
  let pack = await prepareFtDataset()
  // 两个 JSONL 都得有（官方脚本的 eval_strategy 是无条件 steps），判据在共享缝里，好让探针盯住。
  const ready = judgeFtDataset(pack)
  if (!ready.ok) {
    return { ok: false, error: ready.error }
  }
  const trainer = env.paths.trainer ?? 'qwen3-sft'
  // 增量：找上一轮权重 → 沿用上一轮验证集 → 把权重抄进 <engine>.next。
  // 任何一步接不上都拒启动并点名缺什么：静默落回「从底模重训」是外行人看不出的一小时白跑。
  let source: IncrementalSource | null = null
  let stagedPath: string | null = null
  if (mode === 'incremental') {
    const found = findIncrementalSource(pack.ledger, trainer)
    if (!found.ok) return { ok: false, error: found.error }
    source = found.source
    pack = await prepareFtDataset({ evalKeys: source.evalKeys })
    const repacked = judgeFtDataset(pack)
    if (!repacked.ok) return { ok: false, error: repacked.error }
    const staged = stageIncrementalSource(source, stagingDir())
    if (!staged.ok) return { ok: false, error: staged.error }
    stagedPath = staged.stagedPath
  }
  const tuning: AsrFtTrainTuning = planFtTuning({
    mode,
    trainer,
    trainCount: pack.trainCount,
    lastStep: source?.lastStep ?? 0,
    resumeFrom: stagedPath,
    initFrom: stagedPath
  })
  const stamp = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')
  // 目录名固定 ASCII（ft-<时间戳>）：decoder 的 fp32 中间产物超过 2 GB，torch 的 external-data
  // 写入在 Windows 上用窄字符路径开文件，路径里带中文（曾用数据集名当目录名「地图」）会
  // `Could not open file or directory: <dir>/thinker.model.embed_tokens.weight` 直接失败。
  const stem = `ft-${stamp}`
  const runDir = join(app.getPath('userData'), 'asr-ft-runs', stem)
  const exportDir = join(app.getPath('userData'), 'asr-ft-onnx', stem)
  // 官方脚本不建输出目录，先垫好省得训练第一步就摔。
  mkdirSync(runDir, { recursive: true })
  mkdirSync(exportDir, { recursive: true })
  // run.json 记这次跑到哪一步；逐条指纹的账本随请求交给 manager 落库（开训一行，成功才标已训）。
  writeRunMeta(runDir, {
    runId: stem,
    startedAt: Date.now(),
    mode,
    epochs: tuning.epochs ?? 66,
    lr: tuning.lr ?? '2e-5',
    // 接续起点：qwen3 是 checkpoint，funasr 是那份抄进 .next 的权重（同一字段，事后一眼看得出接的哪份）。
    resumeFrom: tuning.resumeFrom ?? tuning.initFrom ?? null,
    status: 'running',
    finishedAt: null,
    exportDir,
    applied: false
  })
  return {
    ok: true,
    warning: vramNote,
    request: {
      kind: 'asr-ft',
      // ASR 微调没有「数据集名」这个概念：目录名固定 ft-<时间戳>，字段留空只为满足请求契约。
      dataset: '',
      mode,
      asrFt: {
        paths: env.paths as AsrFtPaths,
        data: { trainJsonl: pack.trainPath, evalJsonl: pack.evalPath, runDir },
        exportDir,
        // manager 开训即把这份账本写进 train/runs.db；训练成功再把 run_id 落到这些条目上。
        ledger: pack.ledger,
        tuning
      }
    }
  }
}

/** 训练成功后的链式下一步：挑编号最大的 checkpoint，拼导出命令；没存出 checkpoint 就 null。 */
export function buildAsrFtExportPlan(request: TrainStartRequest): TrainPlan | null {
  const asr = request.asrFt
  if (!asr) return null
  // funasr 走打包的导出工具，其余 trainer 必须真有导出脚本才继续。
  if (asr.paths.trainer !== 'funasr-paraformer' && !asr.paths.exportScript) return null
  const exportTool =
    asr.paths.trainer === 'funasr-paraformer' ? locateWorkerScript('asr-ft-export-funasr.py') : ''
  if (asr.paths.trainer === 'funasr-paraformer' && !exportTool) return null
  // 走到这里 = 训练腿 exit 0（manager 的链回调）：账本标 trained；导出腿接着跑，转正再标 applied。
  markRunStatus(asr.data.runDir, 'trained')
  // funasr 的 run 目录本身就是 checkpoint 目录（config.yaml + 权重同层，没有 checkpoint-<n> 子目录）。
  // 权重优先取 trainer 收尾平均出来的 model.pt.avg1（= 验证最好的那个），再退 best，最后才是最后一个 epoch。
  const checkpointDir =
    asr.paths.trainer === 'funasr-paraformer' ? asr.data.runDir : pickLastCheckpointName(safeReaddir(asr.data.runDir))
  // ranking 只看最后一个 epoch 会跳过验证最好的那份：训完 trainer 会把最好的权重平均成 model.pt.avg1。
  const weightsFile =
    ['model.pt.avg1', 'model.pt.best', 'model.pt'].find((name) => existsSync(join(asr.data.runDir, name))) ??
    'model.pt'
  if (!checkpointDir) return null
  return {
    exe: asr.paths.pythonExe,
    args: planAsrFtExportArgv(asr.paths, checkpointDir, asr.exportDir, exportTool, weightsFile),
    // cwd 钉在导出目录：hydra 会在 cwd 里建 outputs/，不能让它在安装目录里落垃圾。
    cwd: asr.paths.exportScript ? dirname(asr.paths.exportScript) : asr.exportDir,
    // 导出也读底模：hub id 只走 modelscope，缓存钉进应用数据目录（<envRoot>/modelscope-cache）。
    env: { MODELSCOPE_CACHE: join(dirname(dirname(dirname(asr.paths.pythonExe))), 'modelscope-cache') }
  }
}
