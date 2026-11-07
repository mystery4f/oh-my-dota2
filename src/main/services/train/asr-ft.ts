import { app } from 'electron'
import { errorMessage } from '@shared/errors'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, dirname, join } from 'node:path'
import {
  asrFtRollbackSteps,
  asrFtSwapSteps,
  deriveAsrFtEnvGaps,
  planAsrFtExportArgv,
  pickLastCheckpointName,
  type AsrFtPaths,
  type AsrFtStatusResult,
  type AsrFtSwapResult,
  type AsrFtTrainTuning,

  type FtLedgerEntry,
  type FtRunMeta,
  deriveFtEpochs,
  deriveFtResumeEpochs,
  ftVramNote,
  judgeFtDataset,
  missingFtExportFiles,
  FT_MODEL_FILES,
  ftLedgerMatchedOnDisk,
  ftTrainCoverage,
  parseNvidiaComputeApps
} from '@shared/train/asr-ft'
import type { TrainPlan, TrainStartRequest } from '@shared/train/task'
import { loadSettings } from '../settings'
import { resetSherpaWorker } from '../voice/sherpa-asr'
import { prepareFtDataset } from './ft-dataset'
import { ftRecList } from './ft-record'
import { sovitsChildPid } from '../voice/sovits-server'

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

function layoutCandidates(root: string): AsrFtLayout[] {
  return [
    {
      // 应用内安装的规范布局
      pythonExe: join(root, 'venv', 'Scripts', 'python.exe'),
      sftScript: join(root, 'sft', 'qwen3_asr_sft.py'),
      exportScript: join(root, 'export', 'export_qwen3_asr_onnx.py'),
      baseModelDir: join(root, 'models', 'Qwen3-ASR-0.6B')
    },
    {
      // 手动开发布局（试点环境：uv 环境 + 官方仓库 + 导出仓库克隆）
      pythonExe: join(root, 'env', 'Scripts', 'python.exe'),
      sftScript: join(root, 'Qwen3-ASR', 'finetuning', 'qwen3_asr_sft.py'),
      exportScript: join(root, 'Qwen3-ASR-onnx', 'export_qwen3_asr_onnx.py'),
      baseModelDir: join(root, 'models', 'Qwen3-ASR-0.6B')
    }
  ]
}

/** 按布局探环境：sft 脚本出现在哪套布局就认哪套；啥都没有就按规范布局报缺。 */
export function detectAsrFtEnv(): { ok: boolean; gaps: string[]; paths: Partial<AsrFtPaths>; envRoot: string } {
  const envRoot = asrFtEnvRoot()
  const picked = layoutCandidates(envRoot).find((layout) => existsSync(layout.sftScript)) ?? layoutCandidates(envRoot)[0]
  const paths: Partial<AsrFtPaths> = {
    pythonExe: existsSync(picked.pythonExe) ? picked.pythonExe : '',
    sftScript: existsSync(picked.sftScript) ? picked.sftScript : '',
    exportScript: existsSync(picked.exportScript) ? picked.exportScript : '',
    baseModelDir: existsSync(join(picked.baseModelDir, 'model.safetensors')) ? picked.baseModelDir : ''
  }
  const gaps = deriveAsrFtEnvGaps({ ...paths, venvOk: Boolean(paths.pythonExe) })
  return { ok: gaps.length === 0, gaps, paths, envRoot }
}

function asrModelsRoot(): string {
  return join(app.getPath('userData'), 'asr-models')
}

function activeDir(): string {
  return join(asrModelsRoot(), 'qwen3-asr')
}

/**
 * 对讲下载的官方模型（voice-runtime/models/qwen3-asr）。第一次换模时 asr-models 还不存在，
 * 词表只能从这里借——微调不动词表，借来仍是同一份。
 */
function shippedModelDir(): string {
  return join(app.getPath('userData'), 'voice-runtime', 'models', 'qwen3-asr')
}

function backupDir(): string {
  return join(asrModelsRoot(), 'qwen3-asr.bak')
}

function stagingDir(): string {
  return join(asrModelsRoot(), 'qwen3-asr.next')
}

function safeReaddir(dir: string): string[] {
  try {
    return readdirSync(dir)
  } catch {
    return []
  }
}

/** 导出产物目录：asr-ft-onnx/ 下最新一个带 decoder.int8.onnx 的（就是链式导出写出来的那个）。 */
function lastExportDir(): string | null {
  const root = join(app.getPath('userData'), 'asr-ft-onnx')
  const entries = safeReaddir(root)
    .filter((name) => existsSync(join(root, name, 'decoder.int8.onnx')))
    .sort()
  return entries.length > 0 ? join(root, entries[entries.length - 1]) : null
}


/** 换模四态的同步视图：asrFtStatus（含已训标记，异步）和 applyAsrFtModel（同步）共用。 */
function swapView(): AsrFtStatusResult['swap'] {
  return {
    activeExists: existsSync(join(activeDir(), 'decoder.int8.onnx')),
    bakExists: existsSync(join(backupDir(), 'decoder.int8.onnx')),
    nextExists: existsSync(join(stagingDir(), 'decoder.int8.onnx')),
    lastExportDir: lastExportDir()
  }
}
/** 环境检测 + 换模视图 + 已训标记（coverage）；安装进行时由 ipc 层补（install 字段），避免和安装器互相 import。 */
export async function asrFtStatus(): Promise<Omit<AsrFtStatusResult, 'install'>> {
  const env = detectAsrFtEnv()
  return {
    env: { ok: env.ok, gaps: env.gaps, envRoot: env.envRoot },
    swap: swapView(),
    coverage: ftTrainCoverage(latestFtLedger(), await ftRecList())
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
          for (const file of FT_MODEL_FILES) cpSync(join(swap.lastExportDir, file), join(next, file))
          const tokenizer = join(swap.lastExportDir, 'tokenizer')
          if (existsSync(tokenizer)) cpSync(tokenizer, join(next, 'tokenizer'), { recursive: true })
        }
        // 兜底顺序：刚进备份的上一版 → asr-models 下任何自带词表的目录 → 对讲下载的官方模型。
        const fallbacks = [bak, ...safeReaddir(asrModelsRoot()).map((d) => join(asrModelsRoot(), d)), shippedModelDir()]
        if (ensureTokenizerFiles(next, fallbacks) === 'no-source') {
          throw new Error('导出产物缺 tokenizer 词表文件，备份和原始模型目录里也没得借')
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
  return join(app.getPath('userData'), 'asr-ft-runs')
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

/** 读一个 run 的 dataset.jsonl 账本；没有 / 坏了回空。 */
function readRunLedger(runDir: string): FtLedgerEntry[] {
  try {
    return readFileSync(join(runDir, 'dataset.jsonl'), 'utf8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line) as FtLedgerEntry)
  } catch {
    return []
  }
}

/** 最近一次微调的账本：runs 按名字倒序（ft-<时间戳> 字典序 = 时间序），第一个有账本的。 */
function latestFtLedger(): FtLedgerEntry[] {
  for (const name of safeReaddir(runsRoot()).sort().reverse()) {
    const ledger = readRunLedger(join(runsRoot(), name))
    if (ledger.length > 0) return ledger
  }
  return []
}

/**
 * 续训候选：最新的 run，其账本与当前打包账本逐条指纹全等（旧数据只增不改）且还留着 checkpoint。
 * 对不上（重录 / 删过）就 null——静默落回全新开跑，续训绝不接错底。
 */
function latestResumableRun(currentLedger: FtLedgerEntry[]): { resumeFrom: string; lastStep: number } | null {
  for (const name of safeReaddir(runsRoot()).sort().reverse()) {
    const runDir = join(runsRoot(), name)
    const past = readRunLedger(runDir)
    if (!ftLedgerMatchedOnDisk(past, currentLedger)) continue
    const checkpoint = pickLastCheckpointName(safeReaddir(runDir))
    if (!checkpoint) continue
    return { resumeFrom: join(runDir, checkpoint), lastStep: Number(checkpoint.slice('checkpoint-'.length)) }
  }
  return null
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
  const steps = asrFtRollbackSteps({ bakExists: existsSync(join(backupDir(), 'decoder.int8.onnx')) })
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
export async function resolveAsrFtTrainRequest(resume: boolean): Promise<{
  ok: boolean
  request?: TrainStartRequest
  error?: string
  warning?: string | null
}> {
  const env = detectAsrFtEnv()
  if (!env.ok || !env.paths.pythonExe) {
    return { ok: false, error: `微调环境没就绪：${env.gaps.join('；')}` }
  }
  const vramNote = ftVramGuard()
  const pack = await prepareFtDataset()
  // 两个 JSONL 都得有（官方脚本的 eval_strategy 是无条件 steps），判据在共享缝里，好让探针盯住。
  const ready = judgeFtDataset(pack)
  if (!ready.ok) {
    return { ok: false, error: ready.error }
  }
  // 续训：窗口开关 + 上次账本对得上才接旧 checkpoint（lr 降一档防把权重带飞）；接不上静默新开。
  const prior = resume ? latestResumableRun(pack.ledger) : null
  const tuning: AsrFtTrainTuning = prior
    ? { epochs: deriveFtResumeEpochs(pack.trainCount, prior.lastStep), lr: '1e-5', resumeFrom: prior.resumeFrom }
    : { epochs: deriveFtEpochs(pack.trainCount) }
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
  // 账本落盘：dataset.jsonl（逐条指纹，续训对账 + 已训标记）+ run.json（这次跑到哪一步）。
  writeFileSync(join(runDir, 'dataset.jsonl'), `${pack.ledger.map((e) => JSON.stringify(e)).join('\n')}\n`, 'utf8')
  writeRunMeta(runDir, {
    runId: stem,
    startedAt: Date.now(),
    epochs: tuning.epochs ?? 66,
    lr: tuning.lr ?? '2e-5',
    resumeFrom: tuning.resumeFrom ?? null,
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
      asrFt: {
        paths: env.paths as AsrFtPaths,
        data: { trainJsonl: pack.trainPath, evalJsonl: pack.evalPath, runDir },
        exportDir,
        tuning
      }
    }
  }
}

/** 训练成功后的链式下一步：挑编号最大的 checkpoint，拼导出命令；没存出 checkpoint 就 null。 */
export function buildAsrFtExportPlan(request: TrainStartRequest): TrainPlan | null {
  const asr = request.asrFt
  if (!asr || !asr.paths.exportScript) return null
  // 走到这里 = 训练腿 exit 0（manager 的链回调）：账本标 trained；导出腿接着跑，转正再标 applied。
  markRunStatus(asr.data.runDir, 'trained')
  const checkpoint = pickLastCheckpointName(safeReaddir(asr.data.runDir))
  if (!checkpoint) return null
  return {
    exe: asr.paths.pythonExe,
    args: planAsrFtExportArgv(asr.paths, join(asr.data.runDir, checkpoint), asr.exportDir),
    cwd: dirname(asr.paths.exportScript)
  }
}
