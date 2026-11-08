import React from 'react'
import type { TrainSnapshot, TrainTaskInfo } from '@shared/train/task'

/** 运行中的三个状态：任务行据此变色，页面据此禁用开训。 */
const RUNNING = new Set(['running', 'preparing', 'stopping'])
/** 只有这两个状态会带来后续事件；stopping 已经在收场路上，该刷新就刷新。 */
const LIVE = new Set(['running', 'preparing'])

export interface TrainConsole {
  snapshot: TrainSnapshot | null
  setSnapshot: (next: TrainSnapshot) => void
  task: TrainTaskInfo | null
  taskRunning: boolean
  busy: string
  note: string
  /** 单飞的动作包装：同一时刻只跑一个，跑完刷新收场数据。 */
  run: (label: string, action: () => Promise<string>) => Promise<void>
  /** 重新读一次快照与列表（刷新键用）。 */
  reload: () => Promise<void>
}

/**
 * 训练页的运行台：快照订阅、「当前任务」的推导、动作单飞与提示语。
 *
 * 音色训练与识别训练两个页面此前各写一遍这四件事，连注释都一样；差别只在
 * 「收场后要刷新哪些列表」，所以刷新是入参，其余留在这里——改一处就只改一处。
 */
export function useTrainConsole(load: () => Promise<TrainSnapshot>): TrainConsole {
  const [snapshot, setSnapshot] = React.useState<TrainSnapshot | null>(null)
  const [busy, setBusy] = React.useState('')
  const [note, setNote] = React.useState('')

  React.useEffect(() => {
    void load().then(setSnapshot)
    return window.api.onTrainState((next) => {
      setSnapshot(next)
      if (next.task !== null && LIVE.has(next.task.status)) return
      // 收场后记录与产物都变了：列表、环境、已训标记一起刷新。
      void load().then(setSnapshot)
    })
  }, [load])

  const run = async (label: string, action: () => Promise<string>): Promise<void> => {
    if (busy) return
    setBusy(label)
    setNote(`${label}…`)
    try {
      setNote(await action())
    } catch (err) {
      setNote(`${label}失败：${String(err)}`)
    } finally {
      setBusy('')
      setSnapshot(await load())
    }
  }

  const reload = async (): Promise<void> => {
    setSnapshot(await load())
  }

  const task = snapshot?.task ?? null
  return {
    snapshot,
    setSnapshot,
    task,
    taskRunning: task !== null && RUNNING.has(task.status),
    busy,
    note,
    run,
    reload
  }
}
