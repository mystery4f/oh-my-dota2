/**
 * train 探针的搭台工：临时 userData 换根、借件种子、导出目录与训练轮工厂。
 * 只搭台不断言——断言序列留在 train.ts；这台子换模段要用就开，用完 restore。
 */
import { app } from 'electron'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AsrEngineId, AsrFinetuneSpec } from '@shared/asr/engines'
import { buildTrainRun, finishTrainRun, type TrainRunRecord } from '@shared/train/run'
import { saveTrainRun } from '../services/train/run-store'

export interface TrainFixture {
  userData: string
  /** 样例按这条引擎腿搭：现役目录锚点、点名、产物表都从它来。 */
  engineId: AsrEngineId
  canonicalRel: string
  spec: AsrFinetuneSpec
  seedBorrowFiles(): void
  makeExport(name: string, body: string): string
  makeRun(experiment: string, exportDir: string, startedAt: number): TrainRunRecord
  restoreUserData(): void
}

/**
 * 把 userData 临时指到 `<root>/userdata-swap` 并搭好样例工厂；一切路径都从
 * app.getPath('userData') 现推，用完必须调 restoreUserData（探针 finally 里）。
 */
export function openTrainFixture(
  root: string,
  engine: { id: AsrEngineId; canonicalRel: string; finetune: AsrFinetuneSpec }
): TrainFixture {
  const userData = join(root, 'userdata-swap')
  mkdirSync(userData, { recursive: true })
  const realUserData = app.getPath('userData')
  app.setPath('userData', userData)

  // 借件（qwen3 的 tokenizer/、paraformer 的 tokens.txt）真机从官方模型目录借，这里塞进一个「任意目录」。
  function seedBorrowFiles(): void {
    const seedDir = join(userData, 'asr-models', 'seed')
    mkdirSync(join(seedDir, 'tokenizer'), { recursive: true })
    for (const file of ['tokenizer_config.json', 'vocab.json', 'merges.txt']) {
      writeFileSync(join(seedDir, 'tokenizer', file), '{}', 'utf8')
    }
    writeFileSync(join(seedDir, 'tokens.txt'), 'token\n', 'utf8')
  }

  // 导出目录：产物按引擎表的 from / to 各写一份（导出链落 from，转正拷 to；两处同名时就是一份）。
  function makeExport(name: string, body: string): string {
    const dir = join(userData, 'asr-ft-onnx', name)
    mkdirSync(dir, { recursive: true })
    for (const artifact of engine.finetune.artifacts) {
      writeFileSync(join(dir, artifact.from), `${body}|${artifact.to}`, 'utf8')
      if (artifact.to !== artifact.from) writeFileSync(join(dir, artifact.to), `${body}|${artifact.to}`, 'utf8')
    }
    return dir
  }

  function makeRun(experiment: string, exportDir: string, startedAt: number): TrainRunRecord {
    const runDir = join(userData, 'asr-ft-runs', experiment)
    mkdirSync(runDir, { recursive: true })
    const run = finishTrainRun(buildTrainRun({ kind: 'asr-ft', experiment, artifacts: { runDir, exportDir }, startedAt }), {
      status: 'trained',
      endedAt: startedAt + 1000
    })
    saveTrainRun(run)
    return run
  }

  return {
    userData,
    engineId: engine.id,
    canonicalRel: engine.canonicalRel,
    spec: engine.finetune,
    seedBorrowFiles,
    makeExport,
    makeRun,
    restoreUserData: () => app.setPath('userData', realUserData)
  }
}
