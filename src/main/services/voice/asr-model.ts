import { app } from 'electron'
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ASR_ENGINE_LIST, ASR_ENGINES, ASR_MODEL_ROOTS, requiredPathsAll, type AsrEngineSpec } from '@shared/asr/engines'
import {
  collectAsrModels,
  pickActiveAsrModel,
  sherpaKindFor,
  type AsrDirFact,
  type AsrModel,
  type AsrState
} from '@shared/asr/models'
import type { OfflineStatus } from '@shared/ipc'
import { loadSettings, saveSettings } from '../settings'
import { hfMirrorRepoFileUrl } from '@shared/voice-runtime'
import { createInstallJob } from '../install-job'
import { downloadResumable } from '../net/download'
import { sha256File } from './runtime'
import { resetSherpaWorker, sherpaNodeBinary, sherpaTranscribe } from './sherpa-asr'

/**
 * 识别模型的唯一入口：磁盘上有哪些模型、现在用哪份、下载与转写都从这里走。
 *
 * 分工：引擎长什么样是 `@shared/asr/engines` 的表，目录事实怎么变成模型列表是
 * `@shared/asr/models` 的纯函数，这里只做「碰 fs 的采集 + 副作用」。
 * 换引擎/换权重都不该再动这个文件——加引擎是改表 + worker 适配器。
 */


/** 下载进度只留一份（面板轮询的就是它）：目录与清单都来自引擎表，这里只管字节数。 */
let asrDownload: { downloading: boolean; progress: number; error: string | null } = {
  downloading: false,
  progress: 0,
  error: null
}

function modelDirOf(spec: AsrEngineSpec): string {
  return underUserData(spec.canonicalRel)
}

/**
 * 按清单逐件下载到引擎的规范目录。字节数已对的直接跳过（断点/重进都不重下），
 * 下完逐件 sha256 校验——不符就删掉报错，绝不把坏文件留给识别器。
 */
const modelDownloadJob = createInstallJob()

async function downloadAsrModel(spec: AsrEngineSpec): Promise<void> {
  const download = spec.download
  if (download === null) return
  await modelDownloadJob.run({
    busyError: '模型正在下载，等这一轮结束',
    onProgress: (progress) => {
      asrDownload = { ...asrDownload, progress }
    },
    onSettled: (ok, error) => {
      asrDownload = { downloading: false, progress: ok ? 1 : 0, error: ok ? null : error }
    },
    work: async (report) => {
      asrDownload = { downloading: true, progress: 0, error: null }
      const total = download.files.reduce((sum, file) => sum + file.bytes, 0)
      let doneBytes = 0
      for (const file of download.files) {
        const dest = join(modelDirOf(spec), file.path)
        const have = existsSync(dest) ? statSync(dest).size : -1
        if (have !== file.bytes) {
          mkdirSync(dirname(dest), { recursive: true })
          await downloadResumable({
            url: hfMirrorRepoFileUrl(download.repo, file.path),
            dest,
            expectedBytes: file.bytes,
            stallMs: 60_000,
            onProgress: (done) => {
              report((doneBytes + done) / total)
            }
          })
        }
        if (sha256File(dest) !== file.sha256) {
          rmSync(dest, { force: true })
          throw new Error(`${spec.label} 的 ${file.path} 校验不符，已删掉，可重试`)
        }
        doneBytes += file.bytes
        report(doneBytes / total)
      }
    }
  })
}
function underUserData(rel: string): string {
  return join(app.getPath('userData'), rel)
}

/**
 * 扫两个模型根的下层目录，把必备文件的大小与目录体积采上来。
 * 只 stat 表里点名的路径：拿 `readdir` 递归算总大小在 1GB 级目录上要几秒，面板每次刷新都付不起。
 */
function dirFacts(): AsrDirFact[] {
  const paths = requiredPathsAll()
  const facts: AsrDirFact[] = []
  for (const rootRel of ASR_MODEL_ROOTS) {
    const root = underUserData(rootRel)
    let names: string[] = []
    try {
      names = readdirSync(root)
    } catch {
      continue
    }
    for (const name of names) {
      const dir = join(root, name)
      try {
        if (!statSync(dir).isDirectory()) continue
      } catch {
        continue
      }
      const sizes: Record<string, number> = {}
      let bytes = 0
      for (const path of paths) {
        let size = -1
        try {
          size = statSync(join(dir, path)).size
        } catch {
          size = -1
        }
        sizes[path] = size
        if (size > 0) bytes += size
      }
      facts.push({ rel: `${rootRel}/${name}`, sizes, bytes })
    }
  }
  return facts
}

/** 面板用的快照：模型列表 + 生效 id + 是否钉过。 */
export function asrState(): AsrState {
  const models = collectAsrModels(dirFacts())
  const pinnedId = loadSettings().asrActiveModel
  const active = pickActiveAsrModel(models, pinnedId)
  return { models, activeId: active?.id ?? '', pinned: pinnedId !== '' }
}

/** 生效的现役模型；一份 ready 的都没有就 null（识别入口据此说「没模型」）。 */
export function activeAsrModel(): AsrModel | null {
  const models = collectAsrModels(dirFacts())
  return pickActiveAsrModel(models, loadSettings().asrActiveModel)
}

export function engineSpecOf(model: AsrModel): AsrEngineSpec {
  return ASR_ENGINES[model.engineId]
}

export function asrModelDir(model: AsrModel): string {
  return underUserData(model.rel)
}

/**
 * 钉一份现役模型。只接受注册表里真实存在的 id：手改设置写成不存在的值，
 * 识别会悄悄回落，那种「我明明选了 X」最难查。换模型要顺带杀掉常驻 worker，
 * 否则旧识别器还连着旧目录的文件。
 */
export function setActiveAsrModel(id: string): AsrState {
  const hit = collectAsrModels(dirFacts()).find((model) => model.id === id)
  if (!hit) return asrState()
  saveSettings({ asrActiveModel: hit.id })
  resetSherpaWorker()
  return asrState()
}

/**
 * 现役模型的下载/就绪状态。`bytes` 与 `dir` 跟着现役走，
 * 这样面板那一行「已就绪 942MB / 目标路径」显示的就是真正在用的那份。
 */
export function asrStatus(): OfflineStatus {
  const models = collectAsrModels(dirFacts())
  const active = pickActiveAsrModel(models, loadSettings().asrActiveModel)
  const state = { ...asrDownload, verifying: false }
  const fallback = ASR_ENGINE_LIST.find((spec) => spec.download !== null) ?? ASR_ENGINE_LIST[0]
  return {
    available: sherpaNodeBinary() !== null,
    ready: active?.ready ?? false,
    bytes: active?.bytes ?? 0,
    dir: active ? asrModelDir(active) : underUserData(fallback?.canonicalRel ?? ''),
    downloading: state.downloading,
    progress: state.progress,
    verifying: state.verifying,
    error: state.error
  }
}

/**
 * 下载现役引擎的底模。只有「现役就是该引擎的规范目录、且这个引擎表里有下载清单」才真下：
 * 别的组合（选中了备份、或引擎本身只能手动放置）下载也没有落点，如实返回当前状态。
 */
export async function ensureActiveAsrModel(): Promise<OfflineStatus> {
  const active = activeAsrModel()
  const spec = active ? engineSpecOf(active) : ASR_ENGINE_LIST.find((item) => item.download !== null)
  if (spec === undefined || active?.ready) return asrStatus()
  // 只有「现役就是这个引擎的规范目录」或「压根没有现役」才有下载落点；
  // 选中备份/手动目录时下载没地方可放，如实返回当前状态。
  if (active !== null && active.rel !== spec.canonicalRel) return asrStatus()
  await downloadAsrModel(spec)
  return asrStatus()
}

/**
 * 删掉现役模型的目录：只删下载或手动放置的那份。备份与待转正的目录是回滚用的，
 * 面板上也不给这两个入口——真要清理由训练面板的回滚/转正流程负责。
 */
export function removeActiveAsrModel(): { ok: boolean; error: string | null } {
  const active = activeAsrModel()
  if (active !== null && active.origin !== 'backup' && active.origin !== 'finetuned') {
    rmSync(asrModelDir(active), { recursive: true, force: true })
    resetSherpaWorker()
  }
  return { ok: true, error: null }
}

/**
 * 转写一段 16k 单声道 PCM16 WAV。返回 null = 这句不识别（调用方画一行错误）。
 * 热词只喂给声明了 prompt 的引擎；FunASR 家族输出的空格分隔单字按表里 joinChars 拼回去。
 */
export async function transcribeAsr(wavPath: string): Promise<{ text: string } | null> {
  const active = activeAsrModel()
  if (!active?.ready) return null
  if (!sherpaNodeBinary()) return null
  const spec = engineSpecOf(active)
  const hotwords = spec.hotwords === 'prompt' ? loadSettings().asrHotwords : ''
  const result = await sherpaTranscribe({
    kind: sherpaKindFor(active),
    dir: asrModelDir(active),
    wav: wavPath,
    hotwords
  })
  if (!result) return null
  return { text: spec.joinChars ? result.text.replace(/\s+/g, '') : result.text }
}
