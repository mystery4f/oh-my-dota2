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
