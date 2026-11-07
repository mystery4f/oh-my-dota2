import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import {
  buildFtDatasetEntries,
  buildFtJsonlText,
  splitTrainEval,
  type FtDatasetPrepareResult
} from '@shared/train/dataset'
import type { FtLedgerEntry } from '@shared/train/asr-ft'
import type { FtDatasetEntry } from '@shared/train/dataset'
import { ftRecList, ftRecPath, readFtScript } from './ft-record'

/**
 * 一键打包（#14）：把已录的句子×稿子文字合成官方 qwen3_asr_sft.py 要的 JSONL。
 * 录音留在原地不复制——训练脚本（外部工具）直接读 app 数据目录的绝对路径；
 * 产物落在 userData/asr-ft-datasets/，照样守「app 数据不外流」的规矩。
 */

export function ftDatasetDir(): string {
  return join(app.getPath('userData'), 'asr-ft-datasets')
}

export async function prepareFtDataset(): Promise<FtDatasetPrepareResult> {
  const script = await readFtScript()
  if (script.error || script.groups.length === 0) {
    return fail(script.error ?? '内置读稿为空')
  }
  const recorded = new Set((await ftRecList()).map((info) => info.key))
  const { entries } = buildFtDatasetEntries(
    script.groups,
    (group, line) => recorded.has(`${group}-${line}`),
    (group, line) => ftRecPath(group, line),
  )
  if (entries.length === 0) {
    return fail('还没有已录的句子——先在上方录几条再打包')
  }
  if (entries.length < 2) {
    return fail('只有一条录音不够——官方脚本必须带验证集，至少再录一条再打包')
  }
  if (!entries.every((entry) => existsSync(entry.wavPath))) {
    return fail('有录音文件丢失（列表和磁盘对不上），重录缺失的句子后再打包')
  }
  const { train, eval: evalSet } = splitTrainEval(entries)
  const dir = ftDatasetDir()
  await mkdir(dir, { recursive: true })
  const trainPath = join(dir, 'train.jsonl')
  const evalPath = join(dir, 'eval.jsonl')
  await writeFile(trainPath, buildFtJsonlText(train), 'utf8')
  // 两条起 splitTrainEval 一定切出验证集：官方脚本 eval_strategy="steps" 无条件，空验证集会 ValueError。
  await writeFile(evalPath, buildFtJsonlText(evalSet), 'utf8')
  return {
    ok: true,
    trainCount: train.length,
    evalCount: evalSet.length,
    trainPath,
    evalPath: evalSet.length > 0 ? evalPath : '',
    ledger: buildLedger(train, evalSet),
    error: null,
  }
}

function fail(error: string): FtDatasetPrepareResult {
  return { ok: false, trainCount: 0, evalCount: 0, trainPath: '', evalPath: '', ledger: [], error }
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
