import { existsSync } from 'node:fs'
import {
  emptyAsrCheckState,
  gradeAsrCheck,
  summarizeAsrCheck,
  type AsrCheckItem,
  type AsrCheckState
} from '@shared/train/asr-check'
import type { CerCohort } from '@shared/train/cer'
import { splitTrainEval } from '@shared/train/dataset'
import { transcribeWav } from '../voice/asr'
import { findDatasetEntry, listDatasetEntries, recordDatasetTake } from './run-store'

/**
 * 全量识别比对：按账本顺序一条一条喂给现役模型，串行跑（sherpa worker 只有一个会话，
 * 并发只会互相抢着加载模型）。状态放进程内存，关掉弹层就丢——重跑一次也就一分钟。
 */

type Listener = (state: AsrCheckState) => void

let state: AsrCheckState = emptyAsrCheckState()
let canceled = false
const listeners = new Set<Listener>()

function publish(next: AsrCheckState): void {
  state = next
  for (const listener of listeners) listener(state)
}

export function onAsrCheckChange(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function asrCheckState(): AsrCheckState {
  return state
}

export function stopAsrCheck(): AsrCheckState {
  if (state.running) canceled = true
  return state
}

/**
 * 开跑：账本里每条（最新修订，带标签的才算）都会被识别一次。
 * 缺文件的跳过但记一行「录音文件丢了」，让它出现在不一致列表里——静默跳过会让人以为那条没问题。
 */
export function startAsrCheck(): AsrCheckState {
  if (state.running) return state
  // 账本按 (key, revision) 存了每一条修订：只留每个 key 的最新一版，否则重录过的句子会被识别两遍。
  const latest = new Map<string, ReturnType<typeof listDatasetEntries>[number]>()
  for (const entry of listDatasetEntries()) {
    if (entry.text.trim() === '') continue
    const known = latest.get(entry.key)
    if (!known || entry.revision > known.revision) latest.set(entry.key, entry)
  }
  const rows = [...latest.values()].sort((left, right) => left.key.localeCompare(right.key))
  // 队列：留出尾部的句子量泛化，被某次 run 吃过的量记忆，两者都没有的老数据单列 unknown。
  // 只报一个合计数是自欺——训练见过的句子当然认得。
  const evalKeys = new Set(splitTrainEval(rows).eval.map((entry) => entry.key))
  const cohortOf: CohortOf = (key, runId) =>
    evalKeys.has(key) ? 'eval' : runId === null ? 'unknown' : 'train'
  canceled = false
  publish({
    running: true,
    done: 0,
    total: rows.length,
    current: '',
    startedAt: Date.now(),
    finishedAt: 0,
    error: null,
    canceled: false,
    items: []
  })
  void run(rows, cohortOf)
  return state
}

type CohortOf = (key: string, runId: string | null) => CerCohort

async function run(rows: ReturnType<typeof listDatasetEntries>, cohortOf: CohortOf): Promise<void> {
  const items: AsrCheckItem[] = []
  for (const row of rows) {
    if (canceled) {
      publish({ ...state, running: false, current: '', canceled: true, finishedAt: Date.now(), items })
      return
    }
    if (!existsSync(row.wavPath)) {
      items.push({
        ...gradeAsrCheck(row.key, row.text, '（录音文件丢了）'),
        grade: 'wrong',
        cohort: cohortOf(row.key, row.runId)
      })
      publish({ ...state, done: state.done + 1, current: row.key, items: [...items] })
      continue
    }
    publish({ ...state, current: row.key })
    const result = await transcribeWav(row.wavPath)
    if (!result.ok) {
      publish({
        ...state,
        running: false,
        current: '',
        finishedAt: Date.now(),
        error: result.error ?? '识别失败',
        items
      })
      return
    }
    items.push({ ...gradeAsrCheck(row.key, row.text, result.text), cohort: cohortOf(row.key, row.runId) })
    const summary = summarizeAsrCheck(items)
    publish({ ...state, done: state.done + 1, items: [...items], current: row.key, error: null })
    // summary 只在需要时读；留着是为了将来把「跑一半的一致率」广播出去。
    void summary
  }
  publish({ ...state, running: false, current: '', finishedAt: Date.now(), items })
}

/**
 * 把「稿子里那句」改回人耳听到的样子，写进账本（新修订），下一次打包与下一次比对都用它。
 *
 * 为什么写账本而不是只改本次结果：这条录音的标签既是打包进训练数据的文本，也是下次比对的答案；
 * 只改内存里那一行，等于把同样的错再犯一遍。写回后账本会多一个修订（text 变了才插），
 * 未训练的行原地更新，已训练的历史保留。
 */
export function correctAsrCheckItem(key: string, text: string): { ok: boolean; revision?: number; error?: string } {
  const clean = text.trim()
  if (clean === '') return { ok: false, error: '改完的句子不能是空的' }
  const entry = findDatasetEntry(key)
  if (entry === null) return { ok: false, error: '账本里没有这条录音' }
  if (entry.text === clean) return { ok: true, revision: entry.revision }
  const saved = recordDatasetTake({ ...entry, text: clean })
  if (!saved) return { ok: false, error: '账本写不进去（数据库没打开）' }
  const next = findDatasetEntry(key)
  // 本次比对的这一行也改掉，否则列表里还挂着旧答案，人会以为没保存。
  publish({
    ...state,
    items: state.items.map((item) => (item.key === key ? { ...item, expected: clean } : item))
  })
  return { ok: true, revision: next?.revision ?? entry.revision }
}
