/**
 * 纠错样本（#66）：语音页改对一句时，把那句的原始录音留成自由说样本。
 *
 * 为什么要在内存里存最近几句：识别发生在语音页（浮层），纠错发生在面板，两次点击之间那
 * 个 `voice/utterance.wav` 早被下一句覆盖了。`transcribeAudio` 交付结果时顺手把 wav 放进来，
 * 并给这一段发一张票（utteranceId）交给渲染层；纠错时票原样回来，按票找回原音。
 * 不能按文本找：同一句说过两遍，文本一样、录音不同，按文本会拿到较新那段配到较旧那行上。
 *
 * 配额到顶只停写 + 提示，**绝不删旧样本**：那是已经录好、还没训的数据（spec 里「最旧先丢」的
 * 写法在这里被票面否决）。同一句再改一次换标签、原地覆盖（账本记新修订），不新增一条。
 */
import { existsSync } from 'node:fs'
import { mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app } from 'electron'
import {
  CORRECTION_GROUP,
  correctionTakeKey,
  isCorrectionTakeKey,
  judgeCorrectionSamples,
  nextCorrectionTakeNo,
  type CorrectionLimits,
  type FtCorrectionInput,
  type FtCorrectionSamples,
  type FtCorrectionSaveResult
} from '@shared/train/corrections'
import { loadSettings } from '../settings'
import { recordDatasetTake } from '../train/run-store'

/** 纠错落库结果就是 IPC 那个类型（`@shared/train/corrections`），这里只起个本地的短名。 */
export type CorrectionSaveResult = FtCorrectionSaveResult

export interface CorrectionSample {
  key: string
  bytes: number
}

/** 内存里留几句原音：面板连着纠三句也不至于找不到，多了白占内存。 */
const STASH_MAX = 8

interface StashedUtterance {
  /** 识别那一刻发下去的票：面板纠错时原样带回来，按它对录音，不看文本。 */
  id: string
  wav: Uint8Array
  /** 已经写过样本的键：同一条再改一次覆盖它，不新增一条。 */
  key: string | null
}

const stash: StashedUtterance[] = []
let nextUtteranceId = 0

/**
 * `transcribeAudio` 交付结果时调用：给这段原音发一张票并返回给渲染层。
 * 空的文本 / 空的 wav 直接丢、返回 null——没有票的纠错会明说原音不在了，不猜。
 */
export function stashUtterance(transcript: string, wav: Uint8Array): string | null {
  if (!transcript.trim() || wav.byteLength === 0) return null
  nextUtteranceId += 1
  const id = `u${nextUtteranceId}`
  stash.push({ id, wav, key: null })
  while (stash.length > STASH_MAX) stash.shift()
  return id
}

function stashedFor(utteranceId: string): StashedUtterance | null {
  const id = utteranceId.trim()
  if (!id) return null
  return stash.find((item) => item.id === id) ?? null
}

function defaultRoot(): string {
  return join(app.getPath('userData'), 'asr-ft')
}

/**
 * 自由说组里现有的纠错样本（只数 T 键：G01 里还躺着逐句录音 L01..，它们不进这条配额）。
 * 读不到目录就是 0 条，不是错误——第一句纠错才把这组建出来。
 */
export async function listCorrectionTakes(root: string): Promise<CorrectionSample[]> {
  const dir = join(root, CORRECTION_GROUP)
  if (!existsSync(dir)) return []
  const takes: CorrectionSample[] = []
  for (const name of await readdir(dir)) {
    if (!name.toLowerCase().endsWith('.wav')) continue
    const key = name.slice(0, -'.wav'.length)
    if (!isCorrectionTakeKey(key)) continue
    const info = await stat(join(dir, name))
    if (!info.isFile()) continue
    takes.push({ key, bytes: info.size })
  }
  return takes.sort((a, b) => a.key.localeCompare(b.key))
}

/** 面板状态行：自由说组现在多少条 / 多少字节 / 到没到顶。 */
export async function correctionSamplesStatus(): Promise<FtCorrectionSamples> {
  return judgeCorrectionSamples(await listCorrectionTakes(defaultRoot()))
}

/**
 * 写一条样本：`<root>/G01/G01-Tnn.wav` + 账本一行（正文 = 改对的那句）。
 * 传 `key`（同一句再改一次）换标签、原地覆盖；否则按「最大号 + 1」新开一条。
 */
export async function writeCorrectionSample(input: {
  root: string
  wav: Uint8Array
  corrected: string
  key?: string | null
  limits?: CorrectionLimits
}): Promise<CorrectionSaveResult> {
  const label = input.corrected.trim()
  if (!label) return { saved: false, key: null, notice: '改对的那句是空的：这次没存纠错样本' }
  const takes = await listCorrectionTakes(input.root)
  const reuse = input.key && isCorrectionTakeKey(input.key) ? input.key : null
  // 覆盖那一条也要过字节判定：换一段更大的音一样顶同一个 200 MB 上限（条数不增）。
  const onDisk = reuse !== null && takes.some((take) => take.key === reuse)
  const judged = judgeCorrectionSamples(takes, input.wav.byteLength, input.limits, onDisk ? reuse : null)
  if (judged.atCap) return { saved: false, key: null, notice: judged.notice }
  const key = reuse ?? correctionTakeKey(nextCorrectionTakeNo(takes.map((take) => take.key)))
  const dir = join(input.root, CORRECTION_GROUP)
  await mkdir(dir, { recursive: true })
  const wavPath = join(dir, `${key}.wav`)
  await writeFile(wavPath, input.wav)
  const info = await stat(wavPath)
  const recorded = recordDatasetTake({
    key,
    wavPath,
    bytes: info.size,
    mtimeMs: Math.round(info.mtimeMs),
    text: label,
    split: 'train'
  })
  // 账本没记上 = 这句不会进打包（P2-1）。文件留下来（删它才是丢数据），但话要说在前面。
  return {
    saved: true,
    key,
    notice: recorded ? null : `已写入 ${key}.wav，但训练账本没记上（数据库打不开）：这句不会进打包`
  }
}

/**
 * 面板「存」按钮的落点：开关关着就什么都不做（notice 也留空——关掉是用户的意图，不是失败）；
 * 开着但没有这句的原音，明说一句人话，别让人以为存上了。
 */
export async function saveVoiceCorrection(
  input: FtCorrectionInput,
  options?: { enabled?: boolean; root?: string; limits?: CorrectionLimits }
): Promise<CorrectionSaveResult> {
  const enabled = options?.enabled ?? loadSettings().asrCorrectionsToDataset
  if (!enabled) return { saved: false, key: null, notice: null }
  const found = stashedFor(input.utteranceId)
  if (!found) {
    return {
      saved: false,
      key: null,
      notice: '这句的录音已经不在内存里了（只留最近 8 句），这次只并了热词'
    }
  }
  const result = await writeCorrectionSample({
    root: options?.root ?? defaultRoot(),
    wav: found.wav,
    corrected: input.corrected,
    key: found.key,
    limits: options?.limits
  })
  if (result.saved) found.key = result.key
  return result
}
