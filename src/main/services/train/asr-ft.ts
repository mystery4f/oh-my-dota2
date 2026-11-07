import { app } from 'electron'
import { errorMessage } from '@shared/errors'
import { cpSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  asrFtRollbackSteps,
  asrFtSwapSteps,
  deriveAsrFtEnvGaps,
  planAsrFtExportArgv,
  pickLastCheckpointName,
  type AsrFtPaths,
  type AsrFtStatusResult,
  type AsrFtSwapResult
} from '@shared/train/asr-ft'
import type { TrainPlan, TrainStartRequest } from '@shared/train/task'
import { loadSettings } from '../settings'
import { resetSherpaWorker } from '../voice/sherpa-asr'
import { prepareFtDataset } from './ft-dataset'

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

/** 环境检测 + 换模视图；安装进行时由 ipc 层补（install 字段），避免和安装器互相 import。 */
export function asrFtStatus(): Omit<AsrFtStatusResult, 'install'> {
  const env = detectAsrFtEnv()
  return {
    env: { ok: env.ok, gaps: env.gaps, envRoot: env.envRoot },
    swap: {
      activeExists: existsSync(join(activeDir(), 'decoder.int8.onnx')),
      bakExists: existsSync(join(backupDir(), 'decoder.int8.onnx')),
      nextExists: existsSync(join(stagingDir(), 'decoder.int8.onnx')),
      lastExportDir: lastExportDir()
    }
  }
}

/** tokenizer_config.json 兜底：导出产物不带它，sherpa 启动又要它（词表没变，从备份或原始模型目录借）。 */
function ensureTokenizerConfig(into: string, fallbackDirs: string[]): string | null {
  const target = join(into, 'tokenizer', 'tokenizer_config.json')
  if (existsSync(target)) return null
  for (const dir of fallbackDirs) {
    const source = join(dir, 'tokenizer', 'tokenizer_config.json')
    if (existsSync(source)) {
      cpSync(source, target)
      return source
    }
  }
  return 'no-source'
}

export function applyAsrFtModel(): AsrFtSwapResult {
  const status = asrFtStatus()
  const steps = asrFtSwapSteps(status.swap)
  if (steps.length === 0 || !status.swap.lastExportDir) {
    return { ok: false, error: '没有可应用的新模型：先跑一次训练，等「导出 ONNX」完成再点' }
  }
  const active = activeDir()
  const bak = backupDir()
  const next = stagingDir()
  try {
    for (const op of steps) {
      if (op === 'rm-bak') rmSync(bak, { recursive: true, force: true })
      if (op === 'bak-active') renameSync(active, bak)
      if (op === 'promote-next') {
        rmSync(next, { recursive: true, force: true })
        cpSync(status.swap.lastExportDir, next, { recursive: true })
        if (ensureTokenizerConfig(next, [bak, asrModelsRoot()]) === 'no-source') {
          throw new Error('导出产物缺 tokenizer/tokenizer_config.json，也没有旧模型可以借')
        }
        renameSync(next, active)
      }
    }
  } catch (err) {
    return { ok: false, error: `换模失败：${errorMessage(err)}（模型目录可能停在中间态，按「回滚上一版」恢复）` }
  }
  resetSherpaWorker()
  return { ok: true, error: null }
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

/** 训练启动前把环境、数据、目录都备齐：缺一样就拒启动，成功返回带 asrFt 附件的请求。 */
export async function resolveAsrFtTrainRequest(): Promise<{
  ok: boolean
  request?: TrainStartRequest
  error?: string
}> {
  const env = detectAsrFtEnv()
  if (!env.ok || !env.paths.pythonExe) {
    return { ok: false, error: `微调环境没就绪：${env.gaps.join('；')}` }
  }
  const pack = await prepareFtDataset()
  if (!pack.ok || !pack.trainPath || !pack.evalPath) {
    return { ok: false, error: pack.error ?? '训练数据打包失败' }
  }
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
  return {
    ok: true,
    request: {
      kind: 'asr-ft',
      // ASR 微调没有「数据集名」这个概念：目录名固定 ft-<时间戳>，字段留空只为满足请求契约。
      dataset: '',
      asrFt: {
        paths: env.paths as AsrFtPaths,
        data: { trainJsonl: pack.trainPath, evalJsonl: pack.evalPath, runDir },
        exportDir
      }
    }
  }
}

/** 训练成功后的链式下一步：挑编号最大的 checkpoint，拼导出命令；没存出 checkpoint 就 null。 */
export function buildAsrFtExportPlan(request: TrainStartRequest): TrainPlan | null {
  const asr = request.asrFt
  if (!asr || !asr.paths.exportScript) return null
  const checkpoint = pickLastCheckpointName(safeReaddir(asr.data.runDir))
  if (!checkpoint) return null
  return {
    exe: asr.paths.pythonExe,
    args: planAsrFtExportArgv(asr.paths, join(asr.data.runDir, checkpoint), asr.exportDir),
    cwd: dirname(asr.paths.exportScript)
  }
}
