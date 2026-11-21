import { exitProbe, probeCases } from './harness'
import { existsSync, readFileSync } from 'node:fs'
import {
  ERROR_KEEP,
  errorsLine,
  normalizeErrorInput,
  summarizeErrors,
  type ErrorRecord
} from '@shared/error-log'
import { errorsLogPath, errorsSummary, noteError, resetErrorLog } from '../services/error-log'

/**
 * 本地异常清单（`--error-log-probe`，ci: true）。
 *
 * 两件事分开钉：纯缝（怎么归类、怎么合并、念出来的那句话对不对）与落盘
 * （真的写进 `logs/errors.jsonl`，且探针进程里那份日志在临时目录，不碰用户的）。
 * 「未捕获异常真的被接住」没法在这里验——那要真让主进程崩一次，而崩了就没法报结果。
 */
export async function runErrorLogProbe(): Promise<void> {
  const { cases, push } = probeCases()
  const at = new Date(Date.UTC(2026, 10, 21, 12, 0, 0))

  // —— 纯缝：认得出、认不出的都不许变成空记录
  push('Error 取 message', normalizeErrorInput(new Error('boom'), 'uncaught', at)?.message === 'boom', '')
  push('字符串原样', normalizeErrorInput('  boom  ', 'rejection', at)?.message === 'boom', '')
  push('对象里带 message 取它', normalizeErrorInput({ message: 'from obj' }, 'renderer', at)?.message === 'from obj', '')
  push('认不出的对象退化成 JSON', normalizeErrorInput({ code: 42 }, 'renderer', at)?.message === '{"code":42}', '')
  push('null / undefined / 空串一律不记', normalizeErrorInput(null, 'uncaught', at) === null && normalizeErrorInput(undefined, 'rejection', at) === null && normalizeErrorInput('   ', 'renderer', at) === null, '')

  const withStack = normalizeErrorInput(new Error('boom'), 'uncaught', at)
  push('时间戳是 ISO 且带 stack', withStack?.at === '2026-11-21T12:00:00.000Z' && (withStack?.stack ?? '').includes('boom'), withStack?.at ?? 'null')

  // —— 纯缝：合并与排序
  const records: ErrorRecord[] = [
    { at: '2026-11-21T12:00:01.000Z', kind: 'uncaught', message: 'a', stack: null, context: null },
    { at: '2026-11-21T12:00:02.000Z', kind: 'uncaught', message: 'a', stack: null, context: null },
    { at: '2026-11-21T12:00:03.000Z', kind: 'rejection', message: 'b', stack: null, context: null },
    { at: '2026-11-21T12:00:04.000Z', kind: 'uncaught', message: 'a', stack: null, context: null }
  ]
  const summary = summarizeErrors(records, 5)
  push('同类同句合并成一条并计数', summary.groups[0]?.message === 'a' && summary.groups[0]?.count === 3, `count=${summary.groups[0]?.count}`)
  push('两类都数', summary.byKind.uncaught === 3 && summary.byKind.rejection === 1, JSON.stringify(summary.byKind))
  push('total 与 distinct 分开', summary.total === 4 && summary.distinct === 2, `${summary.total}/${summary.distinct}`)
  push('最近一次取最大时间', summary.newest === '2026-11-21T12:00:04.000Z', summary.newest ?? 'null')
  push('样本是最新那条', summary.groups[0]?.sample.at === '2026-11-21T12:00:04.000Z', summary.groups[0]?.sample.at ?? 'null')
  push('不同消息不合并', summarizeErrors(records, 5).distinct === 2, '')
  push('top 截断但 distinct 仍是实数', summarizeErrors(records, 1).groups.length === 1 && summarizeErrors(records, 1).distinct === 2, '')

  // —— 面板那句话
  push('没有异常就照实说没有', errorsLine(summarizeErrors([], 5)) === '没有记录到异常', errorsLine(summarizeErrors([], 5)))
  const line = errorsLine(summary)
  push('一行话里有次数与最常见的那句', line.includes('4 条异常') && line.includes('最常见：a（3 次）') && line.includes('最近 12:00:04'), line)

  // —— 落盘：走真 IO，但探针的 logsDir 是临时目录
  resetErrorLog()
  const logged = noteError(new Error('probe-synthetic'), 'uncaught', 'probe')
  const path = errorsLogPath()
  const text = existsSync(path) ? readFileSync(path, 'utf8') : ''
  push('写进 logs/errors.jsonl 且是本进程那条', logged !== null && text.includes('probe-synthetic'), `${text.length} bytes`)
  push('探针写的是临时目录，不是用户的 logs', !path.includes('oh-my-dota2\\data'), path)
  push('内存摘要立刻能看到这条', errorsSummary(5).total === 1, `total=${errorsSummary(5).total}`)
  push('空输入不落盘（文件不因它变长）', noteError('', 'rejection') === null, '')

  // —— 上限：超过 ERROR_KEEP 只留最近的那些
  resetErrorLog()
  for (let i = 0; i < ERROR_KEEP + 5; i += 1) noteError(`burst ${i}`, 'uncaught')
  const burst = errorsSummary(200)
  push('内存里最多留 ERROR_KEEP 条', burst.total === ERROR_KEEP, `total=${burst.total}`)
  push('留下的是最近的（第一条是 burst 5）', burst.groups.some((group) => group.message === `burst ${5}`), '')

  for (const item of cases) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name} ${item.detail}`)
  const failed = cases.filter((item) => !item.ok)
  console.log(
    'ERROR_LOG_PROBE',
    JSON.stringify({ ok: failed.length === 0, passed: cases.length - failed.length, failed: failed.length, path })
  )
  exitProbe(failed.length === 0, cases)
}
