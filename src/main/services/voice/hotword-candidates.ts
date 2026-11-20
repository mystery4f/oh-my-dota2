/**
 * 热词候选池的落盘与提案（issue #74）。
 *
 * 纠错发生时记一笔到 `<userData>/asr-hotword-candidates.json`；面板读清单、人点「并入」
 * 才写 `asrHotwords`——**只写一次**，因为 sherpa 的热词是构造期配置（worker 缓存键里带词表），
 * 每多写一次就多重载一次识别器。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import {
  dismissCandidates,
  mergePlan,
  parseTally,
  rankCandidates,
  recordCorrection,
  type HotwordApplyResult,
  type HotwordSuggestions,
  type HotwordTally
} from '@shared/asr-hotword-candidates'
import { loadSettings, saveSettings } from '../settings'

const FILE_NAME = 'asr-hotword-candidates.json'

export type { HotwordApplyResult, HotwordSuggestions }

function userDataDir(): string {
  return app.getPath('userData')
}

/** 探针要给它一个临时目录，所以路径可注入。 */
export function hotwordCandidatesPath(root = userDataDir()): string {
  return join(root, FILE_NAME)
}

/** 读池子：文件不在、JSON 坏了、字段类型不对，都当空池——它只是建议，坏了不能挡住纠错。 */
export function loadHotwordTally(root = userDataDir()): HotwordTally {
  const path = hotwordCandidatesPath(root)
  if (!existsSync(path)) return parseTally(null)
  try {
    return parseTally(JSON.parse(readFileSync(path, 'utf8')))
  } catch {
    return parseTally(null)
  }
}

/** 原子写：面板随时可能读，不能让它看见半个 JSON。 */
export function saveHotwordTally(tally: HotwordTally, root = userDataDir()): void {
  const path = hotwordCandidatesPath(root)
  const temp = `${path}.tmp`
  writeFileSync(temp, `${JSON.stringify(tally, null, 2)}\n`, 'utf8')
  renameSync(temp, path)
}

/**
 * 记一次纠错。`before` 是识别出来的原句、`after` 是改对的那句。
 * 传空串直接返回——没有原句就无从算差异，别把空样本写进池子。
 */
export function noteCorrection(before: string, after: string, root = userDataDir()): HotwordTally {
  if (!before.trim() || !after.trim()) return loadHotwordTally(root)
  const next = recordCorrection(loadHotwordTally(root), before, after)
  saveHotwordTally(next, root)
  return next
}

/** 面板的提案视图：池子 + 现役词表 + 是否已在表里。 */
export function hotwordSuggestions(): HotwordSuggestions {
  const tally = loadHotwordTally()
  const hotwords = loadSettings().asrHotwords
  return { corrections: tally.corrections, hotwords, suggestions: rankCandidates(tally.candidates, hotwords) }
}

/** 忽略：只清池子里的词，`asrHotwords` 一个字节都不动。 */
export function dismissHotwordCandidates(words: readonly string[]): HotwordSuggestions {
  const tally = dismissCandidates(loadHotwordTally(), words)
  saveHotwordTally(tally)
  return hotwordSuggestions()
}

/**
 * 应用：合并计划里的 `next` 写进 settings 恰好一次（注入的 `save` 让探针数调用次数），
 * 然后把这次处理过的词从池子里摘掉——同一个词不该反复出现在建议里。
 */
export function applyHotwordCandidates(
  words: readonly string[],
  save: (patch: { asrHotwords: string }) => unknown = saveSettings
): HotwordApplyResult {
  const current = loadSettings().asrHotwords
  const plan = mergePlan(current, words)
  if (plan.added.length > 0) save({ asrHotwords: plan.next })
  const handled = [...plan.added, ...plan.already, ...plan.dropped]
  if (handled.length > 0) saveHotwordTally(dismissCandidates(loadHotwordTally(), handled))
  return { ...plan, hotwords: plan.added.length > 0 ? plan.next : current }
}
