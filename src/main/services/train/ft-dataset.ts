import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import {
  buildCorrectionEntries,
  buildFtDatasetEntries,
  buildFtJsonlText,
  buildFtFunasrJsonlText,
  splitIncrementalEval,
  splitTrainEval,
  type FtDatasetPrepareResult
} from '@shared/train/dataset'
import { finetuneSpec } from './target-engine'
import type { FtLedgerEntry } from '@shared/train/asr-ft'
import type { FtDatasetEntry } from '@shared/train/dataset'
import { ftRecList, ftRecPath, readFtScript } from './ft-record'
import { listDatasetEntries } from './run-store'

/**
 * 一键打包（#14）：把已录的句子×稿子文字合成官方 qwen3_asr_sft.py 要的 JSONL。
 * 录音留在原地不复制——训练脚本（外部工具）直接读 app 数据目录的绝对路径；
 * 产物落在 userData/asr-ft-datasets/，照样守「app 数据不外流」的规矩。
 */

export function ftDatasetDir(): string {
  return join(app.getPath('userData'), 'asr-ft-datasets')
}

/**
 * 已录句子 × 稿子 → 待打包条目；缺件时带人话原因。
 * 打包与「当前账本」都从这里取条目，别各自再建一次。`allowSingle` 给账本用：
 * 只有一条时打包会拒（没验证集），但账本仍要有这一条——估时/待训得能说「1 条」，而不是「还没录训练集」。
 *
 * 两类条目的磁盘真值分开判：纠错样本由 `buildCorrectionEntries` 按 existsSync 滤掉缺文件的
 * 那几条（键记在 `skipped` 里，打包照常进行）；逐句录音走下面的 every 门——它们由稿子枚举，
 * 少一个 wav 说明录音目录被动过，让人重录比悄悄少一句强。
 */
async function collectFtEntries(options?: { allowSingle?: boolean }): Promise<{
  entries: FtDatasetEntry[]
  skipped: string[]
  error: string | null
}> {
  const script = await readFtScript()
  if (script.error || script.groups.length === 0) return { entries: [], skipped: [], error: script.error ?? '读稿里没有句子' }
  const recorded = new Set((await ftRecList()).map((info) => info.key))
  const { entries } = buildFtDatasetEntries(
    script.groups,
    (group, line) => recorded.has(`${group}-${line}`),
    (group, line) => ftRecPath(group, line)
  )
  // #66：纠错样本接在逐句录音后面——正文是用户亲手改对的那句，自由说也能监督训练；
  // 只认账本里的（手工录的自由说没有标签，不能进）。磁盘上已经删掉的跳过，不拖垮整份打包。
  const corrections = buildCorrectionEntries(listDatasetEntries(), (wavPath) => existsSync(wavPath))
  entries.push(...corrections.entries)
  const skipped = corrections.missing
  if (entries.length === 0) {
    return { entries, skipped, error: ftPackGate(entries.length, options?.allowSingle === true) }
  }
  // 文件缺失先查：它同时挡住打包与账本（账本的指纹必须是磁盘真值）。
  if (!entries.every((entry) => existsSync(entry.wavPath))) {
    return { entries, skipped, error: '有逐句录音的文件丢失（录音目录和列表对不上），重录缺失的句子后再打包' }
  }
  return { entries, skipped, error: ftPackGate(entries.length, options?.allowSingle === true) }
}
/**
 * 打包门槛（条数 → 拒绝理由，null = 可以打包）：0/1 条的话术只在这里写一遍。
 * `allowSingle` 是账本口：只有一条时开训会拒（凑不出验证集），但估时与「待训」必须先看见这一条，
 * 否则面板会说「还没录训练集」——录了却像没录。
 */
export function ftPackGate(count: number, allowSingle = false): string | null {
  if (count === 0) return '还没有已录的句子——先在上方录几条再打包'
  if (count < 2 && !allowSingle) return '只有一条录音不够——官方脚本必须带验证集，至少再录一条再打包'
  return null
}

/** 当前录音的账本（不落盘）：续训对账、开训体检都读这一份，别各自重算。 */
export async function currentFtLedger(): Promise<FtLedgerEntry[]> {
  const { entries } = await collectFtEntries({ allowSingle: true })
  if (entries.length === 0) return []
  const { train, eval: evalSet } = splitTrainEval(entries)
  return buildLedger(train, evalSet)
}

/**
 * 训练数据格式跟着「训练目标」走，不是跟着现役模型走——两者早就可以不同（见 ADR）。
 * 曾经这里读 activeAsrModel()：切到 qwen3 训练，打包却出了 funasr 的 jsonl，
 * 于是 qwen3 脚本第 106 行 KeyError: 'audio'（41 条数据一条没吃到，11 秒就退出）。
 */
function ftDatasetFormat(): 'qwen3-jsonl' | 'funasr-jsonl' {
  return finetuneSpec().dataset
}

/** 两种格式的差别都收在共享缝里，这里只补磁盘真值（wav 字节数）。 */
function buildJsonlText(entries: FtDatasetEntry[]): string {
  if (ftDatasetFormat() === 'funasr-jsonl') {
    return buildFtFunasrJsonlText(entries.map((entry) => ({ ...entry, wavBytes: statSync(entry.wavPath).size })))
  }
  return buildFtJsonlText(entries)
}

/**
 * 打包：默认尾部 holdout 切验证集；增量微调传入上一轮的验证集（evalKeys），
 * 新录的句子只进训练集——验证集换了，loss 就没法跟前一轮比。
 */
export async function prepareFtDataset(options?: { evalKeys?: readonly string[] }): Promise<FtDatasetPrepareResult> {
  const { entries, skipped, error } = await collectFtEntries()
  if (error) return fail(error, skipped)
  const split = options?.evalKeys ? splitIncrementalEval(entries, options.evalKeys) : splitTrainEval(entries)
  const { train, eval: evalSet } = split
  const dir = ftDatasetDir()
  await mkdir(dir, { recursive: true })
  const trainPath = join(dir, 'train.jsonl')
  const evalPath = join(dir, 'eval.jsonl')
  await writeFile(trainPath, buildJsonlText(train), 'utf8')
  // 两条起 splitTrainEval 一定切出验证集：官方脚本 eval_strategy="steps" 无条件，空验证集会 ValueError。
  await writeFile(evalPath, buildJsonlText(evalSet), 'utf8')
  return {
    ok: true,
    trainCount: train.length,
    evalCount: evalSet.length,
    trainPath,
    evalPath: evalSet.length > 0 ? evalPath : '',
    ledger: buildLedger(train, evalSet),
    skippedCorrections: skipped,
    error: null,
  }
}

function fail(error: string, skipped: string[] = []): FtDatasetPrepareResult {
  return {
    ok: false,
    trainCount: 0,
    evalCount: 0,
    trainPath: '',
    evalPath: '',
    ledger: [],
    skippedCorrections: skipped,
    error
  }
}

/** 账本 = 打包那一刻每条录音的磁盘指纹；续训对账、已训标记、重录检测全靠它。 */
function buildLedger(train: FtDatasetEntry[], evalSet: FtDatasetEntry[]): FtLedgerEntry[] {
  const mark = (entries: FtDatasetEntry[], split: FtLedgerEntry['split']): FtLedgerEntry[] =>
    entries.map((entry) => {
      const st = statSync(entry.wavPath)
      return { key: entry.key, wavPath: entry.wavPath, bytes: st.size, mtimeMs: Math.round(st.mtimeMs), text: entry.text, split }
    })
  return [...mark(train, 'train'), ...mark(evalSet, 'eval')]
}
