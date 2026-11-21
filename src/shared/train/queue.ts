/**
 * #107：训练队列。
 *
 * 为什么要有这一层：训练一次十几分钟到一个多小时，想连跑「全量→增量」时，现在的做法是等在面板前
 * 手动点第二次——人一走，显卡就空着。队列只解决顺序与取消，不解决抢占：正在跑的那个任务永远不被
 * 队列的操作打断（`remove` 只会动还在等的那几位）。
 *
 * 这里只有顺序与文案，不碰进程、不碰磁盘：谁去跑由 `manager.ts` 调 `shift()` 取队头。
 */

/** 排队上限：再多就不是「顺手排两条」，而是把磁盘排满了（每份权重约 15 GB）。 */
export const TRAIN_QUEUE_LIMIT = 5

export interface TrainQueueEntry {
  id: string
  /** 面板与日志里认得出的名字：`增量 asr-ft · G14/G20` 这种。 */
  label: string
  requestedAt: number
}

export interface TrainQueueAddResult {
  ok: boolean
  error: string | null
  position: number
}

/**
 * 先进先出的队列。`remove` 的返回值刻意把「动到正在跑的那个」这件事说清楚：
 * 队列里从来没有「正在跑」的条目，所以想撤正在跑的任务只能走 `stop`，这里会明确拒绝并指路。
 */
export class TrainQueue {
  private entries: TrainQueueEntry[] = []

  constructor(private readonly limit: number = TRAIN_QUEUE_LIMIT) {}

  list(): TrainQueueEntry[] {
    return [...this.entries]
  }

  size(): number {
    return this.entries.length
  }

  has(id: string): boolean {
    return this.entries.some((entry) => entry.id === id)
  }

  add(entry: TrainQueueEntry): TrainQueueAddResult {
    if (this.has(entry.id)) return { ok: false, error: `队列里已经有 ${entry.label} 了`, position: this.entries.length }
    if (this.entries.length >= this.limit) {
      return { ok: false, error: `队列最多排 ${this.limit} 个任务，先跑掉一些再排`, position: this.entries.length }
    }
    this.entries.push(entry)
    return { ok: true, error: null, position: this.entries.length }
  }

  /**
   * 撤掉一个还在等的任务。返回 `removed` 为 null 时，调用方必须把 `error` 原样告诉用户：
   * 已经开跑的任务不经过队列，取消它只能停止。
   */
  remove(id: string): { removed: TrainQueueEntry | null; error: string | null } {
    const index = this.entries.findIndex((entry) => entry.id === id)
    if (index < 0) return { removed: null, error: '这个任务已经开始跑了，停下来请用「停止」' }
    const [removed] = this.entries.splice(index, 1)
    return { removed: removed ?? null, error: null }
  }

  /** 队头出队；没有就返回 null（调用方据此决定要不要开下一个）。 */
  shift(): TrainQueueEntry | null {
    return this.entries.shift() ?? null
  }

  clear(): void {
    this.entries = []
  }
}

/** 一行话：空队列也给一句话，面板不用自己判空。 */
export function trainQueueLine(entries: readonly TrainQueueEntry[]): string {
  if (entries.length === 0) return '没有排队的任务'
  const head = entries[0]
  const rest = entries.length - 1
  return rest === 0 ? `下一个：${head.label}` : `下一个：${head.label} · 后面还有 ${rest} 个`
}

/** 排进来的那一刻给用户回执：第几位。 */
export function trainQueueQueuedLine(label: string, position: number): string {
  return position === 1 ? `已排队：${label}（下一个就是你）` : `已排队：${label}（第 ${position} 位）`
}
