/**
 * #107 训练队列的探针。
 *
 * 票面验收：`three queued runs execute in order; cancelling a waiting entry never touches the running one.`
 *
 * 这里不真开训练进程（一轮十几分钟、要显卡与权重）：用一个「假跑者」按真实调用顺序驱动队列——
 * 正在跑的任务**不在队列里**，这正是「撤排队碰不到正在跑」的结构性保证；探针把它写成断言，
 * 而不是靠读代码确认。
 */
import { finishProbe, probeCases } from './harness'
import {
  TRAIN_QUEUE_LIMIT,
  TrainQueue,
  trainQueueLine,
  trainQueueQueuedLine,
  type TrainQueueEntry
} from '@shared/train/queue'

function entry(label: string, at = 1): TrainQueueEntry {
  return { id: `id-${label}`, label, requestedAt: at }
}

/** 假跑者：按调用顺序记录真正开跑的任务。 */
function runAll(queue: TrainQueue): string[] {
  const ran: string[] = []
  for (let next = queue.shift(); next !== null; next = queue.shift()) ran.push(next.label)
  return ran
}

export async function runTrainQueueProbe(): Promise<void> {
  const { cases, push } = probeCases()

  const three = new TrainQueue()
  three.add(entry('第一个'))
  three.add(entry('第二个'))
  three.add(entry('第三个'))
  const order = runAll(three)
  push('三个排队的任务按顺序跑', order.join('>') === '第一个>第二个>第三个', order.join('>'))
  push('跑完队列清空', three.size() === 0, String(three.size()))

  // —— 撤排队不碰正在跑：正在跑的那个从来不在队列里 ——
  const mixed = new TrainQueue()
  const ran: string[] = ['正在跑的 A']
  mixed.add(entry('排在后面的 B'))
  mixed.add(entry('要被撤掉的 C'))
  const cancelled = mixed.remove('id-要被撤掉的 C')
  push('撤掉还在等的那个：成功且指名撤掉了谁', cancelled.error === null && cancelled.removed?.label === '要被撤掉的 C', cancelled.removed?.label ?? '')
  push('撤掉之后队列里只剩 B', mixed.list().length === 1 && mixed.list()[0].label === '排在后面的 B')
  const touched = mixed.remove('正在跑的 A')
  push(
    '想用队列撤正在跑的任务：拒绝并指路「停止」',
    touched.removed === null && (touched.error ?? '').includes('停止'),
    touched.error ?? ''
  )
  ran.push(...runAll(mixed))
  push('A 跑完之后只接上 B（C 已被撤掉）', ran.join('>') === '正在跑的 A>排在后面的 B', ran.join('>'))

  // —— 上限与重复：排不进去要说清原因，不是静默丢 ——
  const full = new TrainQueue(2)
  full.add(entry('一'))
  full.add(entry('二'))
  const overflow = full.add(entry('三'))
  push('超过上限：拒收并报出上限', overflow.ok === false && (overflow.error ?? '').includes('最多排 2 个'), overflow.error ?? '')
  const dup = full.add(entry('一'))
  push('同一个任务排两次：拒收', dup.ok === false && (dup.error ?? '').includes('队列里已经有'), dup.error ?? '')
  push('默认上限是 5 个', TRAIN_QUEUE_LIMIT === 5, String(TRAIN_QUEUE_LIMIT))

  // —— 文案：空队列、单个、多个都有话说 ——
  push('空队列有一句话', trainQueueLine([]) === '没有排队的任务', trainQueueLine([]))
  push('只有一个时不说「后面还有」', trainQueueLine([entry('只有一个')]).includes('下一个：只有一个') && !trainQueueLine([entry('只有一个')]).includes('后面还有'))
  push('多个时报出后面几个', trainQueueLine([entry('甲'), entry('乙'), entry('丙')]).includes('后面还有 2 个'), trainQueueLine([entry('甲'), entry('乙'), entry('丙')]))
  push('排第一位的回执与第二位不同', trainQueueQueuedLine('甲', 1) !== trainQueueQueuedLine('甲', 2), trainQueueQueuedLine('甲', 2))

  finishProbe('TRAIN_QUEUE_PROBE', cases)
}