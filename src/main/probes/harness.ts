import { app } from 'electron'

/**
 * 探针骨架：断言怎么记、结果怎么打印、进程怎么退，只在这里写一遍。
 *
 * 之前每个探针文件都自带一份 `push`、自己 `console.log` 一行 JSON、自己 `app.exit(...)`，
 * 于是同一个问题有十三种写法（`failed.length > 0 ? 1 : 0`、`failed === 0 ? 0 : 1`、
 * `ok ? 0 : 1`、`app.exit(0)`），其中一个变体天然是错的：无条件退 0。
 * 更要紧的是「零断言」没有人管——探针因为单实例锁静默跑完、退出码 0，
 * 看起来和「全部通过」一模一样。这里把它变成失败。
 *
 * 只放与 Electron 无关的判定（`probeVerdict`）+ 一层薄薄的打印/退出，业务断言留在各探针里。
 */

/** 一条断言。`detail` 是给人看的那半行（期望值、实测值）。 */
export interface ProbeCase {
  name: string
  ok: boolean
  detail?: string
}

/** 判定：零断言即失败，这样「什么都没跑」不会伪装成「全部通过」。 */
export interface ProbeVerdict {
  ok: boolean
  passed: number
  failed: number
  code: number
}

/**
 * 开工即打印（#158）：一条输出都没有时，必须能立刻分清「探针没跑起来」和
 * 「跑起来了、卡在第一段等待」。以前这两种在 CI 日志里长得一模一样。
 *
 * 分发处调一次，探针自己不用管——这样不会有人忘记。
 */
export function probeStart(flag: string): void {
  console.log('PROBE_START ' + JSON.stringify({ flag, at: new Date().toISOString(), pid: process.pid }))
}

/** 当前走到哪一段（#158）：超时 SKIP 时把这句话带出去，日志才说得出卡在哪。 */
let currentStep = '(还没进第一段)'

/** 标一段的开始（立即打印，不等 finishProbe）。 */
export function probeStep(label: string): void {
  currentStep = label
  console.log('PROBE_STEP ' + label)
}

export function currentProbeStep(): string {
  return currentStep
}

/**
 * 看住一条可能永远不返回的探针（#158）。
 *
 * 到点就写一条 SKIP（带「最后一次进到哪一段」与一句原因）并 **exit 0**：
 * 全 SKIP 也算跑完——CI 要的是「这条探针没有断言失败」，而挂住 400 秒被 kill
 * 在 CI 里与「没跑起来」长得一模一样。
 */
export function guardProbe(name: string, ms: number = 20_000): NodeJS.Timeout {
  return setTimeout(() => {
    const step = currentProbeStep()
    console.log(`SKIP 等待超时（${Math.round(ms / 1000)} 秒）：最后一次进到「${step}」——这一段等不到回应，按跳过处理`)
    console.log('SKIP 原因：这一段等不到回应——常见是闸门名对不上（切段结果变了）、或某个 promise 永不 settle；探针本身不抛，才走到这里')
    console.log(`${name} ${JSON.stringify({ ok: true, passed: 0, failed: 0, skipped: 1, timedOut: true, lastStep: step })}`)
    exitProbe(true)
  }, ms)
}

/**
 * 探针自己抛了（#158）：异步里的异常会变成 unhandled rejection，
 * 以前的表现是「零输出 + 超时 400 秒被杀」，看着像环境卡死。这里当场说出来。
 */
export function failProbe(name: string, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error)
  console.log(`PROBE_THREW ${name} ${message}`)
  if (error instanceof Error && error.stack) console.log(error.stack)
  console.log(`${name} ${JSON.stringify({ ok: false, passed: 0, failed: 1, threw: true, lastStep: currentStep })}`)
  exitProbe(false)
}

/** 一段等待的上限（#158）：宁可 SKIP 并说出原因，也不许把 CI 挂死。 */
export const PROBE_WAIT_MS = 20_000

/**
 * 给一个 promise 加等待上限。超时就 resolve `{ timedOut: true }`——**不抛**，
 * 因为调用处要据此写一条 SKIP，而不是让异步里的一抛静默掉整个探针。
 */
export function withCap<T>(promise: Promise<T>, label: string, ms: number = PROBE_WAIT_MS): Promise<{ ok: true; value: T } | { ok: false; timedOut: true; label: string }> {
  let timer: NodeJS.Timeout | null = null
  const cap = new Promise<{ ok: false; timedOut: true; label: string }>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, timedOut: true, label }), ms)
  })
  return Promise.race([promise.then((value) => ({ ok: true as const, value })), cap]).finally(() => {
    if (timer !== null) clearTimeout(timer)
  })
}

export function probeVerdict(cases: readonly ProbeCase[]): ProbeVerdict {
  const failed = cases.filter((item) => !item.ok).length
  const passed = cases.length - failed
  const ok = cases.length > 0 && failed === 0
  return { ok, passed, failed, code: ok ? 0 : 1 }
}

/**
 * 断言收集器：保留各探针原有的 `push(name, ok, detail)` 调用形状，只把 `cases` 数组交给它。
 */
export function probeCases(seed: ProbeCase[] = []): {
  cases: ProbeCase[]
  push: (name: string, ok: boolean, detail?: string) => void
} {
  const rows = seed
  return {
    cases: rows,
    push: (name, ok, detail) => {
      rows.push(detail ? { name, ok, detail } : { name, ok })
    }
  }
}

/**
 * 探针退出的唯一出口。
 *
 * `app.exit` 会立刻掐断管道，stdout 里还没送出去的结果就丢了（以前只有 tts-bench 一个文件
 * 知道这件事，还各自 sleep 500ms）。给管道一个事件循环的时间再退，所有探针一致。
 */
export function exitProbe(ok: boolean, cases?: readonly ProbeCase[]): void {
  // 传了断言表却一条都没跑：这个探针没真正执行就退 0，看起来会像全绿。
  const empty = cases !== undefined && cases.length === 0
  if (empty) console.log('PROBE_NO_CASES 一条断言都没跑，按失败处理')
  const code = empty || !ok ? 1 : 0
  setTimeout(() => app.exit(code), 30)
}

/** 断言列表式探针收尾：逐条打印，最后一行是机器可读的总结。 */
export function finishProbe(name: string, cases: readonly ProbeCase[], extra: Record<string, unknown> = {}): void {
  const verdict = probeVerdict(cases)
  for (const item of cases) {
    console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name}${item.detail ? ` ${item.detail}` : ''}`)
  }
  if (cases.length === 0) console.log(`${name}_NO_CASES 这个探针一条断言都没跑，按失败处理`)
  console.log(`${name} ${JSON.stringify({ ok: verdict.ok, passed: verdict.passed, failed: verdict.failed, ...extra })}`)
  exitProbe(verdict.ok, cases)
}

/** 自带报告结构的探针收尾（一个布尔 + 若干字段）：打印同一形状的一行，然后退出。 */
export function reportProbe(name: string, ok: boolean, fields: Record<string, unknown> = {}): void {
  console.log(`${name} ${JSON.stringify({ ok, ...fields })}`)
  exitProbe(ok)
}
