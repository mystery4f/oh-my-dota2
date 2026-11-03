import { spawn, spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { extname, join } from 'node:path'
import { load as loadYaml, dump as dumpYaml } from 'js-yaml'
import { app } from 'electron'
import {
  buildS1TrainConfigData,
  buildS2TrainConfigData,
  GV_DEFAULTS,
  GV_VERSION_INFO,
  judgeGvDataset,
  normalizeGvVersion,
  type GvDatasetJudgement,
  type GvRegisterPayload,
  type GvRegisterResult,
  type GvTrainOptions,
  type GvVersionInfo,
  type TrainStartRequest
} from '@shared/train'
import { discoverSovitsHome } from '../voice/sovits-server'
import { sovitsRefsRoot, sovitsWeightsRoot } from '../voice/sovits-refs'

/**
 * GV（GPT-SoVITS）微调编排（T3）：备料验收 → 写训练配置 → 交给 TrainManager 跑真训练；
 * 降噪/切分/打标注仍走官方 webui（这里只负责开/关它），训练产物一键登记成音色包。
 *
 * 职责红线：这里只做「把上游 webui 的训练命令原样拼出来」，不改训练逻辑；
 * 参数全部来自窗口表单，缺什么就在 resolve 阶段报错，绝不带病启动。
 */

const GV_SCRIPTS: Record<'gv-sovits' | 'gv-gpt', string> = {
  'gv-sovits': 'GPT_SoVITS/s2_train.py',
  'gv-gpt': 'GPT_SoVITS/s1_train.py'
}

export interface GvResolution {
  ok: boolean
  request?: TrainStartRequest
  error?: string
}

/** 一次 GV 训练启动前的全部检查 + 配置文件落盘；任何缺口都在这里拦住，不进 manager。 */
export function resolveGvTrainRequest(request: TrainStartRequest): GvResolution {
  const kind = normalizeGvKind(request.kind)
  if (!kind) return { ok: false, error: 'GV 任务类型只有 gv-sovits（SoVITS 声学模型）和 gv-gpt（GPT 语义模型）' }
  const script = GV_SCRIPTS[kind]
  const home = discoverSovitsHome()
  if (!home) return { ok: false, error: '没找到 GPT-SoVITS 引擎包：先到面板「TTS 服务」里安装或配置引擎包路径' }
  const pythonExe = join(home, 'runtime', 'python.exe')
  if (!existsSync(pythonExe)) return { ok: false, error: '引擎包不完整：runtime/python.exe 不存在' }
  if (!existsSync(join(home, script))) return { ok: false, error: `引擎包不完整：${script} 不存在` }

  const expName = String(request.dataset ?? '').trim()
  if (!expName || expName.includes('/') || expName.includes('\\') || expName.includes('..')) {
    return { ok: false, error: '实验名不能为空，也不能带路径分隔符' }
  }

  const opts = resolveTrainOptions(request.gv, kind)
  const info = GV_VERSION_INFO[opts.version]

  // 底模/模板缺失早报错：训练跑到一半才缺文件是最贵的失败方式。
  const envErrors = missingEnvFiles(home, info, kind)
  if (envErrors) return { ok: false, error: envErrors }

  const judged = judgeDatasetAt(home, expName)
  if (!judged.ready) {
    return { ok: false, error: `数据集「${expName}」备料不齐（先在 GPT-SoVITS webui 里跑完 1abc 三步）：缺 ${judged.missing.join('、')}` }
  }

  const configFile =
    kind === 'gv-sovits'
      ? writeS2Config(home, info, opts, expName)
      : writeS1Config(home, info, opts, expName)
  if (!configFile.ok) return { ok: false, error: configFile.error ?? '训练配置写盘失败' }

  return {
    ok: true,
    request: { ...request, gv: opts, gvResolved: { home, pythonExe, configFile: configFile.path as string, script: script as string } }
  }
}

function normalizeGvKind(kind: unknown): 'gv-sovits' | 'gv-gpt' | null {
  return kind === 'gv-sovits' || kind === 'gv-gpt' ? kind : null
}

/** 表单缺省时按 kind 兜底（webui 同款保守值），version 乱值打回包默认版本。 */
function resolveTrainOptions(raw: unknown, kind: 'gv-sovits' | 'gv-gpt'): GvTrainOptions {
  const rec = typeof raw === 'object' && raw !== null ? (raw as Partial<GvTrainOptions>) : {}
  const fallback = GV_DEFAULTS[kind]
  return {
    version: normalizeGvVersion(rec.version),
    batchSize: Number.isFinite(rec.batchSize) && (rec.batchSize as number) >= 1 ? Math.floor(rec.batchSize as number) : fallback.batchSize,
    epochs: Number.isFinite(rec.epochs) && (rec.epochs as number) >= 1 ? Math.floor(rec.epochs as number) : fallback.epochs
  }
}

/** 按任务腿检查模板 + 底模在不在；返回 null = 全齐。 */
function missingEnvFiles(home: string, info: GvVersionInfo, kind: 'gv-sovits' | 'gv-gpt'): string | null {
  const checks =
    kind === 'gv-sovits'
      ? [info.s2ConfigTemplate, info.s2PretrainedG, info.s2PretrainedD]
      : [info.s1ConfigTemplate, info.s1Pretrained]
  const missing = checks.filter((rel) => !existsSync(join(home, rel)))
  if (missing.length === 0) return null
  return `引擎包缺 ${kind === 'gv-sovits' ? 'SoVITS' : 'GPT'} 训练所需文件：${missing.join('、')}（换底模齐的版本，或补装引擎包）`
}

/** 数据集四件套验收（复用纯缝判定，主进程只探存在性）。 */
function judgeDatasetAt(home: string, expName: string): GvDatasetJudgement {
  const dir = join(home, 'logs', expName)
  return judgeGvDataset({
    expName,
    phonemes: existsSync(join(dir, '2-name2text.txt')),
    semantic: existsSync(join(dir, '6-name2semantic.tsv')),
    hubert: existsSync(join(dir, '4-cnhubert')),
    wav32k: existsSync(join(dir, '5-wav32k'))
  })
}

/** 列出引擎包 logs/ 下的实验并逐个验收备料；ready 的排前，同状态按名字排。 */
export function scanGvDatasets(home: string): GvDatasetJudgement[] {
  const logsDir = join(home, 'logs')
  if (!existsSync(logsDir)) return []
  const judged: GvDatasetJudgement[] = []
  for (const name of readdirSync(logsDir)) {
    if (!statSync(join(logsDir, name)).isDirectory()) continue
    judged.push(judgeDatasetAt(home, name))
  }
  return judged.sort((a, b) => (a.ready === b.ready ? a.expName.localeCompare(b.expName) : a.ready ? -1 : 1))
}

function ensureTmpDir(home: string): string {
  const dir = join(home, 'tmp')
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeS2Config(
  home: string,
  info: GvVersionInfo,
  opts: GvTrainOptions,
  expName: string
): { ok: boolean; path?: string; error?: string } {
  try {
    const template = readFileSync(join(home, info.s2ConfigTemplate), 'utf-8')
    const data = buildS2TrainConfigData(JSON.parse(template), {
      train: opts,
      expName,
      pretrainedG: info.s2PretrainedG,
      pretrainedD: info.s2PretrainedD,
      sovitsWeightsRoot: info.sovitsWeightsRoot
    })
    if (!data) return { ok: false, error: `配置模板 ${info.s2ConfigTemplate} 结构不对（train/data/model 节点缺失）` }
    const path = join(ensureTmpDir(home), 'tmp_s2.json')
    writeFileSync(path, JSON.stringify(data, null, 2), 'utf-8')
    return { ok: true, path }
  } catch (err) {
    return { ok: false, error: `写 SoVITS 训练配置失败：${err instanceof Error ? err.message : String(err)}` }
  }
}

function writeS1Config(
  home: string,
  info: GvVersionInfo,
  opts: GvTrainOptions,
  expName: string
): { ok: boolean; path?: string; error?: string } {
  try {
    const template = loadYaml(readFileSync(join(home, info.s1ConfigTemplate), 'utf-8'))
    const data = buildS1TrainConfigData(template, {
      train: opts,
      expName,
      pretrainedS1: info.s1Pretrained,
      gptWeightsRoot: info.gptWeightsRoot
    })
    if (!data) return { ok: false, error: `配置模板 ${info.s1ConfigTemplate} 结构不对（train 节点缺失）` }
    const path = join(ensureTmpDir(home), 'tmp_s1.yaml')
    writeFileSync(path, dumpYaml(data), 'utf-8')
    return { ok: true, path }
  } catch (err) {
    return { ok: false, error: `写 GPT 训练配置失败：${err instanceof Error ? err.message : String(err)}` }
  }
}

// —— 官方 webui 的开/关：备料（降噪/切分/标注）仍归它 ——

let webuiPid: number | null = null

export function gvWebuiStatus(): { running: boolean } {
  return { running: webuiPid !== null }
}

export function openGvWebui(): { ok: boolean; error?: string } {
  if (webuiPid !== null) return { ok: true }
  const home = discoverSovitsHome()
  if (!home) return { ok: false, error: '没找到引擎包，webui 开不了' }
  const pythonExe = join(home, 'runtime', 'python.exe')
  if (!existsSync(pythonExe) || !existsSync(join(home, 'webui.py'))) {
    return { ok: false, error: '引擎包不完整：runtime/python.exe 或 webui.py 不存在' }
  }
  const child = spawn(pythonExe, ['webui.py'], { cwd: home, windowsHide: true, detached: true, stdio: 'ignore' })
  child.unref()
  webuiPid = child.pid ?? null
  return { ok: true }
}

export function closeGvWebui(): { ok: boolean; error?: string } {
  if (webuiPid === null) return { ok: true }
  spawnSync('taskkill', ['/pid', String(webuiPid), '/T', '/F'], { timeout: 8000, windowsHide: true })
  webuiPid = null
  return { ok: true }
}

// —— 训练产物一键登记音色包 ——


/** 落盘目录名和音色名同一套约束：中文/字母/数字/连字符，别把路径玩坏。 */
function safeName(name: string): boolean {
  return /^[\w\u4e00-\u9fa5-]{1,40}$/.test(name)
}

/** 权重目录里找本次实验的最新产物（s2/s1 都按 `<实验名>_` 前缀产出，取 mtime 最新）。 */
function pickNewestWeight(dir: string, expName: string): { path: string; base: string } | null {
  if (!existsSync(dir)) return null
  let best: { path: string; base: string; mtime: number } | null = null
  for (const name of readdirSync(dir)) {
    if (!name.startsWith(`${expName}_`)) continue
    const full = join(dir, name)
    if (!statSync(full).isFile()) continue
    const mtime = statSync(full).mtimeMs
    if (!best || mtime > best.mtime) best = { path: full, base: name, mtime }
  }
  return best ? { path: best.path, base: best.base } : null
}

/** 从备料清单里取第一行做参考音频（格式 `wav|说话人|语言|文本`）；原路径丢了就退回 5-wav32k 里的同名 32k 版。 */
function pickRefAudio(home: string, expName: string): { wav: string; text: string } | null {
  const expDir = join(home, 'logs', expName)
  const listFile = existsSync(expDir) ? readdirSync(expDir).find((f) => f.endsWith('.list')) : undefined
  if (!listFile) return null
  const line = readFileSync(join(expDir, listFile), 'utf-8').split(/\r?\n/).find((l) => l.trim())
  if (!line) return null
  const parts = line.split('|')
  if (parts.length < 4) return null
  const original = parts[0].trim()
  const text = parts[3].trim()
  if (!text) return null
  if (existsSync(original)) return { wav: original, text }
  const fallback = join(expDir, '5-wav32k', `${expName}${extname(original)}`)
  return existsSync(fallback) ? { wav: fallback, text } : null
}

/** 训练完成 → 权重拷进数据根 + refs.json 记一条（切换仍走面板既有管线，注册≠切换）。 */
export function registerGvWeights(payload: GvRegisterPayload): GvRegisterResult {
  const name = payload.name.trim()
  if (!safeName(name)) return { ok: false, error: '音色名只能用中文/字母/数字/连字符，最长 40 个字符' }
  const home = discoverSovitsHome()
  if (!home) return { ok: false, error: '没找到引擎包，登记不了' }
  const version = normalizeGvVersion(payload.version)
  const info = GV_VERSION_INFO[version]
  const expName = payload.expName.trim()

  const sovits = pickNewestWeight(join(home, info.sovitsWeightsRoot), expName)
  const gpt = pickNewestWeight(join(home, info.gptWeightsRoot), expName)
  if (!sovits || !gpt) {
    return { ok: false, error: `没找到「${expName}」的训练产物（${info.sovitsWeightsRoot}/ 与 ${info.gptWeightsRoot}/ 下没有匹配权重）：训练成功才有产物可登记` }
  }

  const ref = pickRefAudio(home, expName)
  if (!ref) return { ok: false, error: '备料目录里没有可用的参考音频（.list 第一行 + 5-wav32k 都没找到 wav）' }

  const userData = app.getPath('userData')
  const weightsRoot = sovitsWeightsRoot(userData)
  const refsRoot = sovitsRefsRoot(userData)
  const weightDir = join(weightsRoot, name)
  mkdirSync(weightDir, { recursive: true })
  copyFileSync(sovits.path, join(weightDir, sovits.base))
  copyFileSync(gpt.path, join(weightDir, gpt.base))
  const audioBase = `${name}${extname(ref.wav)}`
  copyFileSync(ref.wav, join(refsRoot, audioBase))

  const entry: Record<string, unknown> = {
    name,
    audio: audioBase,
    promptText: ref.text,
    promptLang: 'zh',
    gptWeights: `${name}/${gpt.base}`,
    sovitsWeights: `${name}/${sovits.base}`
  }

  try {
    const refsFile = join(refsRoot, 'refs.json')
    let current: unknown = []
    try {
      current = JSON.parse(readFileSync(refsFile, 'utf-8'))
    } catch {
      // 坏/缺清单按空处理，写回时整表重建。
    }
    const list = Array.isArray(current) ? current : []
    const next = [...list.filter((item) => (item as Record<string, unknown>)?.name !== name), entry]
    writeFileSync(refsFile, `${JSON.stringify(next, null, 2)}\n`, 'utf-8')
  } catch (err) {
    return { ok: false, error: `refs.json 写盘失败：${err instanceof Error ? err.message : String(err)}` }
  }
  return { ok: true, entry }
}
