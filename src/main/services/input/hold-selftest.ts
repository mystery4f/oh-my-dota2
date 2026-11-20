import type { HoldEdge, HoldSelfTest } from '@shared/hold-selftest'
import { HOLD_EDGE_KEEP } from '@shared/hold-selftest'

/**
 * 按住检测的状态登记处（#95）。
 *
 * 常驻脚本的每一种结局都在这里落一笔：起来了、重开了几次、退回敲一下（附原因）、
 * 以及最近若干条按下/松开。面板只读这一份，别处不许再存一份——两份状态一定会互相矛盾，
 * 而这张表存在的全部意义就是「用户能不能相信按住还在被听见」。
 */

let presence: HoldSelfTest['presence'] = 'off'
let ready = false
let attempts = 0
let fallbackReason: string | null = null
const edges: HoldEdge[] = []

/** 面板读。边数组给副本，调用方改不动真状态。 */
export function holdSelfTest(): HoldSelfTest {
  return { presence, ready, attempts, fallbackReason, edges: edges.map((edge) => ({ ...edge })) }
}

/** 开始拉起常驻进程：清掉上一次的退避计数与退回原因。 */
export function noteHoldStarting(): void {
  presence = 'starting'
  ready = false
  attempts = 0
  fallbackReason = null
}

/** 脚本回报 `OK`：组合键解析成功，现在真的有人在听松开。 */
export function noteHoldReady(): void {
  presence = 'resident'
  ready = true
  attempts = 0
  fallbackReason = null
}

/** 进程退出、准备第 n 次重开。`ready` 归零：这一段按下的键确实会漏。 */
export function noteHoldRetry(attempt: number): void {
  presence = 'starting'
  ready = false
  attempts = attempt
}

/** 重试到头，退回「敲一下」。原因要能直接给用户看。 */
export function noteHoldFallback(reason: string): void {
  presence = 'fallback'
  ready = false
  fallbackReason = reason
}

/** 停掉（切成敲一下模式、退出程序、换键重启之前）。边保留，方便看「刚才是好的」。 */
export function noteHoldStopped(): void {
  presence = 'off'
  ready = false
  attempts = 0
  fallbackReason = null
}

/** 一条真实的边，来自常驻脚本的 stdout。 */
export function noteHoldEdge(kind: HoldEdge['kind'], at = Date.now()): HoldEdge {
  const edge: HoldEdge = { at, kind }
  edges.push(edge)
  if (edges.length > HOLD_EDGE_KEEP) edges.splice(0, edges.length - HOLD_EDGE_KEEP)
  return edge
}

/** 探针用：清空边与状态，模拟全新启动。 */
export function resetHoldSelfTest(): void {
  presence = 'off'
  ready = false
  attempts = 0
  fallbackReason = null
  edges.length = 0
}
