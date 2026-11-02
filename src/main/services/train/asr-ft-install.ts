import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { asrFtEnvRoot } from './asr-ft'
import { downloadPackFile } from '../voice/sovits-voicepack'
import type { AsrFtInstallState } from '@shared/train'

/**
 * ASR 微调环境安装器（M-B）：uv + venv + 冻结依赖 + 底模，全程国内镜像，
 * 断点续传。装完的标准布局和 asr-ft.ts 的 layoutCandidates 对上。
 */

/** npmmirror 的 uv 目录列表（JSON），挑最新版本下 zip 再用系统 tar 解。 */
const UV_LIST_URL = 'https://registry.npmmirror.com/-/binary/uv/'
/** PyPI 国内镜像（普通依赖）。 */
const PYPI_MIRROR = 'https://pypi.tuna.tsinghua.edu.cn/simple'
/** torch cu121 轮子镜像（+cu121 版本不在 PyPI 上，只能 find-links）。 */
const TORCH_CU121_MIRROR = 'https://mirror.nju.edu.cn/pytorch-wheels/cu121/'
/** HuggingFace 国内镜像（底模断点续传走 huggingface-hub）。 */
const HF_MIRROR = 'https://hf-mirror.com'
/** python-build-standalone 国内镜像（uv venv 缺解释器时用它拉）。 */
const PYTHON_MIRROR = 'https://registry.npmmirror.com/-/binary/python-build-standalone'

/** 试点环境的冻结版本（uv pip freeze 实测可跑通训练+导出的组合）。 */
export const ASR_FT_PIP_SPEC: string[] = [
  'torch==2.4.1+cu121',
  'transformers==4.57.6',
  'huggingface-hub==0.34.4',
  'datasets==4.0.0',
  'pyarrow==26.0.0',
  'accelerate==1.12.0',
  'peft==0.21.2',
  'onnx==1.23.2',
  'onnxruntime==1.31.1',
  'safetensors==0.8.0',
  'tokenizers==0.22.2',
  'librosa==0.11.0',
  'soundfile==0.14.0',
  'av==18.1.0',
  'numpy==2.4.6',
  'qwen-asr==0.0.6'
]

export interface AsrFtInstallStep {
  /** 展示名：装 uv / 建 venv / 装依赖 / 下底模。 */
  stage: string
}

/** 纯缝：给定「脚本/uv/venv/模型」四样缺啥，排出要跑的步骤名序列。 */
export function planAsrFtInstallSteps(present: {
  scripts: boolean
  uv: boolean
  venv: boolean
  deps: boolean
  model: boolean
}): string[] {
  const steps: string[] = []
  if (!present.scripts) steps.push('复制训练脚本')
  if (!present.uv) steps.push('下载 uv')
  if (!present.venv) steps.push('创建虚拟环境')
  if (!present.deps) steps.push('安装依赖（约 4GB，含 CUDA 版 torch）')
  if (!present.model) steps.push('下载底模（约 1.2GB）')
  return steps
}


let run: AsrFtInstallState = { running: false, stage: '', progress: 0, error: null }

export function asrFtInstallState(): AsrFtInstallState {
  return { ...run }
}

/** 随包分发的脚本目录（打包后 resourcesPath，开发版项目 resources/）。 */
function bundledScriptDir(): string {
  if (app.isPackaged) return join(process.resourcesPath, 'asr-ft')
  return join(app.getAppPath(), 'resources', 'asr-ft')
}

/** 脚本落位：sft/ 收训练脚本，export/ 收导出脚本+4 个兄弟模块。 */
export function copyAsrFtScripts(envRoot: string): { sftScript: string; exportScript: string } {
  const src = bundledScriptDir()
  const sftDir = join(envRoot, 'sft')
  const exportDir = join(envRoot, 'export')
  mkdirSync(sftDir, { recursive: true })
  mkdirSync(exportDir, { recursive: true })
  const sftScript = join(sftDir, 'qwen3_asr_sft.py')
  const exportScript = join(exportDir, 'export_qwen3_asr_onnx.py')
  copyFileSync(join(src, 'qwen3_asr_sft.py'), sftScript)
  for (const name of ['export_qwen3_asr_onnx.py', 'decoder.py', 'encoder.py', 'conv_frontend.py', 'qwen3_asr.py']) {
    copyFileSync(join(src, name), join(exportDir, name))
  }
  return { sftScript, exportScript }
}

/** npmmirror 目录列表里挑最新的 uv zip 文件名（版本按数值比较，0.10 > 0.9）。 */
export function pickLatestUvAsset(entries: Array<{ name: string; type?: string }>): string | null {
  const zips = entries
    .map((e) => /^uv-(\d+)\.(\d+)\.(\d+)-x86_64-pc-windows-msvc\.zip$/.exec(e.name))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ name: m[0], parts: [Number(m[1]), Number(m[2]), Number(m[3])] }))
  if (zips.length === 0) return null
  const newer = (a: { parts: number[] }, b: { parts: number[] }): number => {
    for (let i = 0; i < 3; i++) if (a.parts[i] !== b.parts[i]) return a.parts[i] - b.parts[i]
    return 0
  }
  return zips.reduce((best, cur) => (newer(cur, best) > 0 ? cur : best)).name
}

function setStage(stage: string, progress = 0): void {
  run = { ...run, stage, progress }
}

async function downloadZip(url: string, dest: string, label: string): Promise<void> {
  const head = await fetch(url, { method: 'HEAD' })
  if (!head.ok) throw new Error(`HTTP ${head.status}`)
  const bytes = Number(head.headers.get('content-length') ?? '0')
  let lastLog = 0
  await downloadPackFile(url, dest, bytes, (done: number) => {
    const now = Date.now()
    if (now - lastLog > 2000 && bytes > 0) {
      lastLog = now
      setStage(label, Math.min(99, Math.round((done / bytes) * 100)))
    }
  })
}

/** 系统 tar 解 zip（Git Bash 的 GNU tar 不行，写死 System32 的）。 */
async function extractZip(zip: string, outDir: string): Promise<void> {
  const { execFile } = await import('node:child_process')
  await new Promise<void>((resolve, reject) => {
    execFile('C:\\Windows\\System32\\tar.exe', ['-xf', zip, '-C', outDir], (err, _stdout, stderr) => {
      if (err) reject(new Error(String(stderr || err.message)))
      else resolve()
    })
  })
}


function runStep(exe: string, args: string[], cwd: string, env: Record<string, string>, label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(exe, args, { cwd, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    let tail = ''
    const onChunk = (chunk: Buffer): void => {
      const text = chunk.toString()
      tail = (tail + text).slice(-2000)
      const line = text.trimEnd().split('\n').pop()
      if (line) console.log(`[asr-ft-install] ${label}: ${line.trim().slice(0, 160)}`)
    }
    child.stdout?.on('data', onChunk)
    child.stderr?.on('data', onChunk)
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${label} 退出码 ${code}：${tail.trim().slice(-400) || '无输出'}`))
    })
  })
}

/** 底模下载脚本：venv 里的 huggingface-hub 走 hf-mirror，断点续传自带。 */
const MODEL_SNIPPET = [
  'import os',
  'from huggingface_hub import snapshot_download',
  `snapshot_download('Qwen/Qwen3-ASR-0.6B', local_dir=os.environ['ASR_FT_MODEL_DIR'],`,
  `  endpoint='${HF_MIRROR}', max_workers=4)`
].join('\n')

/** 一键安装：按缺啥补啥串行执行；并发触发直接拒。 */
export async function installAsrFtEnv(): Promise<AsrFtInstallState> {
  if (run.running) return { ...run, error: '安装已在进行中' }
  const envRoot = asrFtEnvRoot()
  const venvDir = join(envRoot, 'venv')
  const pythonExe = join(venvDir, 'Scripts', 'python.exe')
  const uvExe = join(envRoot, 'uv.exe')
  const modelDir = join(envRoot, 'models', 'Qwen3-ASR-0.6B')
  const hasVenv = existsSync(pythonExe)
  const hasModel = existsSync(join(modelDir, 'model.safetensors'))
  const hasDeps =
    hasVenv &&
    existsSync(join(venvDir, 'Lib', 'site-packages', 'torch')) &&
    existsSync(join(venvDir, 'Lib', 'site-packages', 'qwen_asr'))
  const steps = planAsrFtInstallSteps({
    scripts: existsSync(join(envRoot, 'sft', 'qwen3_asr_sft.py')),
    uv: existsSync(uvExe),
    venv: hasVenv,
    deps: hasDeps,
    model: hasModel
  })
  if (steps.length === 0) {
    run = { running: false, stage: '环境已就绪', progress: 100, error: null }
    return { ...run }
  }
  run = { running: true, stage: steps[0], progress: 0, error: null }
  mkdirSync(envRoot, { recursive: true })
  try {
    for (let i = 0; i < steps.length; i++) {
      setStage(steps[i], Math.round((i / steps.length) * 100))
      if (steps[i] === '复制训练脚本') {
        copyAsrFtScripts(envRoot)
      } else if (steps[i] === '下载 uv') {
        const res = await fetch(UV_LIST_URL)
        if (!res.ok) throw new Error(`uv 目录列表 HTTP ${res.status}`)
        const entries = (await res.json()) as Array<{ name: string }>
        const asset = pickLatestUvAsset(entries)
        if (!asset) throw new Error('uv 目录列表里没有 windows zip')
        const zip = join(envRoot, 'uv.zip')
        await downloadZip(`${UV_LIST_URL}${asset}`, zip, `下载 uv (${asset})`)
        await extractZip(zip, envRoot)
        if (!existsSync(uvExe)) throw new Error('解压后没找到 uv.exe')
      } else if (steps[i] === '创建虚拟环境') {
        await runStep(
          uvExe,
          ['venv', 'venv', '--python', '3.11'],
          envRoot,
          { UV_PYTHON_INSTALL_MIRROR: PYTHON_MIRROR, UV_HTTP_TIMEOUT: '120' },
          'uv venv'
        )
      } else if (steps[i] === '安装依赖（约 4GB，含 CUDA 版 torch）') {
        await runStep(
          uvExe,
          [
            'pip', 'install', '--python', pythonExe,
            '--index-strategy', 'unsafe-best-match',
            '--index-url', PYPI_MIRROR,
            '--find-links', TORCH_CU121_MIRROR,
            ...ASR_FT_PIP_SPEC
          ],
          envRoot,
          { UV_HTTP_TIMEOUT: '600' },
          'pip install'
        )
      } else if (steps[i] === '下载底模（约 1.2GB）') {
        mkdirSync(join(envRoot, 'models'), { recursive: true })
        await runStep(pythonExe, ['-c', MODEL_SNIPPET], envRoot, { ASR_FT_MODEL_DIR: modelDir, HF_ENDPOINT: HF_MIRROR }, '底模下载')
      }
    }
    run = { running: false, stage: '安装完成', progress: 100, error: null }
  } catch (err) {
    run = { running: false, stage: '', progress: 0, error: err instanceof Error ? err.message : String(err) }
  }
  return { ...run }
}
