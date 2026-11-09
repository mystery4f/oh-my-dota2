import { existsSync } from 'node:fs'
import {
  emptyAsrCheckState,
  gradeAsrCheck,
  summarizeAsrCheck,
  type AsrCheckItem,
  type AsrCheckState
} from '@shared/train/asr-check'
import { transcribeWav } from '../voice/asr'
import { listDatasetEntries } from './run-store'

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
  void run(rows)
  return state
}

async function run(rows: ReturnType<typeof listDatasetEntries>): Promise<void> {
  const items: AsrCheckItem[] = []
  for (const row of rows) {
    if (canceled) {
      publish({ ...state, running: false, current: '', canceled: true, finishedAt: Date.now(), items })
      return
    }
    if (!existsSync(row.wavPath)) {
      items.push({ key: row.key, expected: row.text, actual: '（录音文件丢了）', grade: 'wrong', distance: row.text.length })
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
    items.push(gradeAsrCheck(row.key, row.text, result.text))
    const summary = summarizeAsrCheck(items)
    publish({ ...state, done: state.done + 1, items: [...items], current: row.key, error: null })
    // summary 只在需要时读；留着是为了将来把「跑一半的一致率」广播出去。
    void summary
  }
  publish({ ...state, running: false, current: '', finishedAt: Date.now(), items })
}
