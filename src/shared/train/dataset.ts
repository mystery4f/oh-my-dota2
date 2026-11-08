/** 备料打包纯缝（一键数据集）：录音 × 稿子 → 训练条目、JSONL 拼装、组进度。零 IO，磁盘真值由调用方注入。 */
import { recordingKey } from './recording'
import type { FtLedgerEntry } from './asr-ft'
export interface FtDatasetEntry {
  /** 完整录音键（组-句，如 G14-L03）：账本/续训判定按它对账。 */
  key: string
  wavPath: string
  text: string
}

/** 一键准备结果：两份 JSONL 的条数与落盘路径（error 非空时其余无意义）。 */
export interface FtDatasetPrepareResult {
  ok: boolean
  trainCount: number
  evalCount: number
  trainPath: string
  evalPath: string
  /** 本次打包的账本（每条录音的 bytes/mtimeMs 指纹）：交给 manager 写进 `train/runs.db` 的 dataset_entries。 */
  ledger: FtLedgerEntry[]
  error: string | null
}

/** 读稿组/句最小视图（免得共享类型互相循环依赖）。 */
export interface FtDatasetGroupView {
  id: string
  mode: 'lines' | 'free'
  lines: Array<{ no: number; text: string }>
}

/**
 * 录音 × 稿子 → 训练条目。逐句组只收已录的；自由说组没有标准答案，监督训练用不了，整组跳过。
 * hasRec/wavPath 由调用方注入（主进程给磁盘真值，探针给假值），这里不做任何 IO。
 */
export function buildFtDatasetEntries(
  groups: FtDatasetGroupView[],
  hasRec: (group: string, line: string) => boolean,
  wavPath: (group: string, line: string) => string,
): { entries: FtDatasetEntry[]; notRecorded: number } {
  const entries: FtDatasetEntry[] = []
  let notRecorded = 0
  for (const group of groups) {
    if (group.mode === 'free') continue
    for (const line of group.lines) {
      const key = `L${String(line.no).padStart(2, '0')}`
      if (!hasRec(group.id, key)) {
        notRecorded += 1
        continue
      }
      entries.push({ key: `${group.id}-${key}`, wavPath: wavPath(group.id, key), text: line.text })
    }
  }
  return { entries, notRecorded }
}

/**
 * 训练/验证切分：尾部 holdout 条进验证集（录音天然按组序落盘，尾部=最晚录的）。
 * 两条起就必须切出验证集：官方脚本 `eval_strategy="steps"` 是无条件的，没给 eval_dataset 会
 * `ValueError: You have set args.eval_strategy to IntervalStrategy.STEPS but you didn't pass an eval_dataset`
 * （安装版实测）。只有一条时才留空，那种情况 prepareFtDataset 直接拒打包并让人多录一条。
 */
export function splitTrainEval(
  entries: FtDatasetEntry[],
  holdout = 2,
): { train: FtDatasetEntry[]; eval: FtDatasetEntry[] } {
  if (entries.length < 2) return { train: entries.slice(), eval: [] }
  const tail = Math.max(1, Math.min(holdout, Math.floor(entries.length / 2)))
  return { train: entries.slice(0, entries.length - tail), eval: entries.slice(entries.length - tail) }
}

/**
 * 增量微调的切分：验证集沿用上一轮（`evalKeys`），新录的句子只进训练集。
 * 验证集是指标的标尺——每轮换一批句子，loss 就没法跟前一轮比；只有旧验证句还在，这条基线才留得住。
 */
export function splitIncrementalEval(
  entries: FtDatasetEntry[],
  evalKeys: readonly string[],
): { train: FtDatasetEntry[]; eval: FtDatasetEntry[] } {
  const keep = new Set(evalKeys)
  return {
    train: entries.filter((entry) => !keep.has(entry.key)),
    eval: entries.filter((entry) => keep.has(entry.key)),
  }
}

/** 官方 qwen3_asr_sft.py 要的 JSONL 行：中文固定带 language 前缀（实测格式）。 */
export function buildFtJsonlLine(entry: FtDatasetEntry): string {
  return JSON.stringify({ audio: entry.wavPath, text: `language Chinese<asr_text>${entry.text}` })
}

export function buildFtJsonlText(entries: FtDatasetEntry[]): string {
  if (entries.length === 0) return ''
  return `${entries.map((entry) => buildFtJsonlLine(entry)).join('\n')}\n`
}

/** funasr（`IndexDSJsonl`）要的一条：键是小写的 key/source/target，不是 qwen3 那套 audio/text。 */
export interface FtFunasrEntry {
  key: string
  wavPath: string
  text: string
  /** wav 文件字节数：只有 44 字节头 + PCM16 单声道，用它折算时长（不再读一遍文件）。 */
  wavBytes: number
}

/**
 * 官方 `scp2jsonl` 的长度口径：source_len = 10ms 帧数 = 采样数/160，target_len = 字符数。
 * 少了这两项 index_ds 会按 source_len=1 过筛（不报错），排批全乱；照官方口径填才对得上。
 */
export function buildFtFunasrJsonlLine(entry: FtFunasrEntry): string {
  const samples = Math.max(0, Math.floor((entry.wavBytes - 44) / 2))
  return JSON.stringify({
    key: entry.key,
    source: entry.wavPath,
    source_len: Math.max(1, Math.round(samples / 160)),
    target: entry.text,
    target_len: entry.text.length
  })
}

export function buildFtFunasrJsonlText(entries: readonly FtFunasrEntry[]): string {
  if (entries.length === 0) return ''
  return `${entries.map((entry) => buildFtFunasrJsonlLine(entry)).join('\n')}\n`
}

/** 组进度视图（T4 总览/准备报告共用）：done/时长/缺句清单，一组一行。 */
export interface FtGroupProgress {
  id: string
  mode: 'lines' | 'free'
  done: number
  /** lines 组 = 句子总数；free 组没有目标长度，等于 done。 */
  total: number
  durationMs: number
  /** lines 组没录的句号；free 组恒空。 */
  missing: number[]
}

/**
 * 录音 × 稿子 → 组进度。recDurationMs 按完整键（recordingKey 产物）回时长，没录回 null；
 * free 组顺数 T01、T02…断链即止（自由说组没有标准长度，尾段就是终点）。
 */
export function buildFtGroupProgress(
  groups: FtDatasetGroupView[],
  recDurationMs: (key: string) => number | null,
): FtGroupProgress[] {
  const result: FtGroupProgress[] = []
  for (const group of groups) {
    let done = 0
    let durationMs = 0
    const missing: number[] = []
    if (group.mode === 'free') {
      for (let n = 1; ; n += 1) {
        const ms = recDurationMs(recordingKey(group.id, 'free', n))
        if (ms === null) break
        done += 1
        durationMs += ms
      }
    } else {
      for (const line of group.lines) {
        const ms = recDurationMs(recordingKey(group.id, 'lines', line.no))
        if (ms === null) missing.push(line.no)
        else {
          done += 1
          durationMs += ms
        }
      }
    }
    result.push({ id: group.id, mode: group.mode, done, total: group.mode === 'free' ? done : group.lines.length, durationMs, missing })
  }
  return result
}

