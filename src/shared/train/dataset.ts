/** 备料打包纯缝（一键数据集）：录音 × 稿子 → 训练条目、JSONL 拼装、组进度。零 IO，磁盘真值由调用方注入。 */
import { recordingKey } from './recording'
export interface FtDatasetEntry {
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
      entries.push({ wavPath: wavPath(group.id, key), text: line.text })
    }
  }
  return { entries, notRecorded }
}

/**
 * 训练/验证切分：尾部 holdout 条进验证集（录音天然按组序落盘，尾部=最晚录的）；
 * 数据太少（≤2×holdout）就全给训练，验证集留空——试点别为切分浪费数据。
 */
export function splitTrainEval(
  entries: FtDatasetEntry[],
  holdout = 2,
): { train: FtDatasetEntry[]; eval: FtDatasetEntry[] } {
  if (entries.length <= holdout * 2) return { train: entries.slice(), eval: [] }
  return { train: entries.slice(0, entries.length - holdout), eval: entries.slice(entries.length - holdout) }
}

/** 官方 qwen3_asr_sft.py 要的 JSONL 行：中文固定带 language 前缀（实测格式）。 */
export function buildFtJsonlLine(entry: FtDatasetEntry): string {
  return JSON.stringify({ audio: entry.wavPath, text: `language Chinese<asr_text>${entry.text}` })
}

export function buildFtJsonlText(entries: FtDatasetEntry[]): string {
  if (entries.length === 0) return ''
  return `${entries.map((entry) => buildFtJsonlLine(entry)).join('\n')}\n`
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

