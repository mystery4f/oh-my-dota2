/**
 * 热词候选池的纯函数缝：一次纠错记一笔，反复出现的差异词才值得提议。
 *
 * 「只建议，不自动应用」在这里就成立：本模块只算清单与合并计划，不碰 settings。
 * 真正写 `asrHotwords` 的动作在主进程、由面板显式触发，且只写一次。
 */
import { HOTWORD_LIMIT, extractHotwordDiff, joinHotwords, parseHotwords } from './asr-hotwords'

/** 一个候选词：出现了几次、从哪几句原转写里改出来的。 */
export interface HotwordCandidate {
  word: string
  count: number
  /** 原转写（改之前的句子），去重、最多 `CANDIDATE_SAMPLE_LIMIT` 条。 */
  samples: string[]
}

/** 候选池：`corrections` 是总纠错次数（面板显示用），`candidates` 按词归并。 */
export interface HotwordTally {
  corrections: number
  candidates: HotwordCandidate[]
}

/** 面板要的一行：候选 + 是否已在热词表里。 */
export interface HotwordSuggestion extends HotwordCandidate {
  inTable: boolean
}

/** 合并计划：写之前给人看的那几个数。 */
export interface HotwordMergePlan {
  added: string[]
  already: string[]
  /** 表满（`HOTWORD_LIMIT`）之后丢掉的词——先让人看见，再决定要不要清表。 */
  dropped: string[]
  next: string
}

/** 池子最多留多少个词：再多也没人看，面板一屏装不下。 */
export const CANDIDATE_LIMIT = 40

/** 每个候选留几条原句：够看出「它长什么样」就行。 */
export const CANDIDATE_SAMPLE_LIMIT = 3

export const EMPTY_TALLY: HotwordTally = { corrections: 0, candidates: [] }

/** 词汇序：按码点而不是 locale，探针的期望值才不会随系统语言漂。 */
function byWord(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

/**
 * 记一次纠错。差异词只认 ≥2 字（`extractHotwordDiff` 的规矩，单字是噪声）；
 * 一个差异词都没有也算一次纠错——面板要显示「改过 N 次、还没攒出候选」。
 */
export function recordCorrection(tally: HotwordTally, before: string, after: string): HotwordTally {
  const corrections = tally.corrections + 1
  const words = extractHotwordDiff(before, after)
  if (words.length === 0) return { corrections, candidates: tally.candidates }
  const next = tally.candidates.map((item) => ({ ...item, samples: [...item.samples] }))
  for (const word of words) {
    const hit = next.find((item) => item.word === word)
    if (hit) {
      hit.count += 1
      if (!hit.samples.includes(before) && hit.samples.length < CANDIDATE_SAMPLE_LIMIT) hit.samples.push(before)
      continue
    }
    next.push({ word, count: 1, samples: [before] })
  }
  next.sort((a, b) => b.count - a.count || byWord(a.word, b.word))
  return { corrections, candidates: next.slice(0, CANDIDATE_LIMIT) }
}

/**
 * 排序后的建议清单。`inTable` 让面板默认不勾已经有的词——
 * 让人重新勾一遍表里已有的词，等于让人替程序去重。
 */
export function rankCandidates(candidates: readonly HotwordCandidate[], hotwords: string): HotwordSuggestion[] {
  const known = new Set(parseHotwords(hotwords))
  return [...candidates]
    .sort((a, b) => b.count - a.count || byWord(a.word, b.word))
    .map((item) => ({ ...item, samples: [...item.samples], inTable: known.has(item.word) }))
}

/**
 * 合并计划。表满时不静默丢弃、也不覆盖现役词：被丢掉的词单独列出来，
 * 面板先把这三个数说清楚，再让人决定写不写。
 */
export function mergePlan(hotwords: string, chosen: readonly string[]): HotwordMergePlan {
  const merged = parseHotwords(hotwords)
  const added: string[] = []
  const already: string[] = []
  const dropped: string[] = []
  for (const raw of chosen) {
    const word = raw.trim()
    if (!word) continue
    if (merged.includes(word)) {
      if (!already.includes(word)) already.push(word)
      continue
    }
    if (merged.length >= HOTWORD_LIMIT) {
      dropped.push(word)
      continue
    }
    merged.push(word)
    added.push(word)
  }
  return { added, already, dropped, next: joinHotwords(merged) }
}

/**
 * 一次合并里真正算「已处理」的词：进了表的与已在表里的。
 * 表满丢下的（`dropped`）**不算**——它们要被留着，等人清几个再勾上重并（#138）。
 */
export function handledWords(plan: HotwordMergePlan): string[] {
  return [...plan.added, ...plan.already]
}

/** 从池里移除若干词（应用成功或用户忽略之后）。计数不动，它记的是「改过几次」。 */
export function dismissCandidates(tally: HotwordTally, words: readonly string[]): HotwordTally {
  const drop = new Set(words.map((word) => word.trim()).filter((word) => word !== ''))
  if (drop.size === 0) return tally
  return { corrections: tally.corrections, candidates: tally.candidates.filter((item) => !drop.has(item.word)) }
}

/**
 * 读盘容错：候选池是本地缓存，坏了就当空的（最多丢建议，不影响热词表本身）。
 * 每个字段都要过类型判断——不信任磁盘上的任何东西。
 */
export function parseTally(raw: unknown): HotwordTally {
  if (typeof raw !== 'object' || raw === null) return EMPTY_TALLY
  const source = raw as { corrections?: unknown; candidates?: unknown }
  const corrections =
    typeof source.corrections === 'number' && Number.isFinite(source.corrections) && source.corrections > 0
      ? Math.floor(source.corrections)
      : 0
  const candidates: HotwordCandidate[] = []
  if (Array.isArray(source.candidates)) {
    for (const item of source.candidates) {
      if (typeof item !== 'object' || item === null) continue
      const row = item as { word?: unknown; count?: unknown; samples?: unknown }
      const word = typeof row.word === 'string' ? row.word.trim() : ''
      if (!word || word.length < 2) continue
      const count = typeof row.count === 'number' && Number.isFinite(row.count) && row.count > 0 ? Math.floor(row.count) : 1
      const samples = Array.isArray(row.samples)
        ? row.samples.filter((sample): sample is string => typeof sample === 'string' && sample !== '').slice(0, CANDIDATE_SAMPLE_LIMIT)
        : []
      if (candidates.some((existing) => existing.word === word)) continue
      candidates.push({ word, count, samples })
    }
  }
  candidates.sort((a, b) => b.count - a.count || byWord(a.word, b.word))
  return { corrections, candidates: candidates.slice(0, CANDIDATE_LIMIT) }
}

/** 面板提案视图：攒了多少次纠错、现役词表、排序后的候选。 */
export interface HotwordSuggestions {
  corrections: number
  hotwords: string
  suggestions: HotwordSuggestion[]
}

/** 应用结果：计划里的三个分组 + 最终写进 `asrHotwords` 的串。 */
export interface HotwordApplyResult extends HotwordMergePlan {
  hotwords: string
}

