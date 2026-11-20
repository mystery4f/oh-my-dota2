/**
 * 保真守卫遥测的纯决策缝，零网络零模型：违例事件怎么产生、三段口径怎么算、
 * 攒批写盘会不会把正常译文也写一条。周报数字的可信度全押在这几条断言上。
 *
 * 说清楚这里钉住的**没有**什么：没有「漏检率」。模型把 bkb 写坏而守卫没抓到，
 * 代码里没有第二个判官，这条断言也造不出来——所以口径只有 blocked / recovered / gaveUp。
 */
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { exitProbe } from './harness'
import { guardedTranslate } from '@shared/translate-fidelity'
import {
  parseGuardEvent,
  summarizeGuardEvents,
  summarizeGuardLog,
  type GuardEvent
} from '@shared/guard-telemetry'
import { appendCappedJsonlMany } from '../services/logs/jsonl'

const event = (over: Partial<GuardEvent> = {}): GuardEvent => ({
  at: '2026-11-20T00:00:00.000Z',
  via: 'session',
  direction: 'zh-en',
  tokens: ['bkb'],
  retryTokens: [],
  outcome: 'recovered',
  ...over
})

export async function runTranslateGuardProbe(): Promise<void> {
  const checks: { name: string; ok: boolean; detail?: string }[] = []
  const add = (name: string, ok: boolean, detail?: string): void => {
    checks.push(detail === undefined ? { name, ok } : { name, ok, detail })
  }

  // ---- guardedTranslate：正常译文一次都不投递（热路径零写入的唯一保证）----
  const seen: GuardEvent[] = []
  const clean = await guardedTranslate('bkb ready', 'bkb ready', 'zh-en', 'session', async () => 'unused', (item) =>
    seen.push(item)
  )
  add('无违例：原样返回且不投递任何事件', clean === 'bkb ready' && seen.length === 0, `sent=${seen.length}`)

  // ---- 违例 + 重试修好：recovered，tokens 是源文里丢掉的缩写 ----
  const recovered: GuardEvent[] = []
  const fixed = await guardedTranslate(
    'bkb还差200块钱',
    'bkg need money',
    'zh-en',
    'session',
    async () => 'bkb need 200 gold',
    (item) => recovered.push(item)
  )
  add(
    '违例后重试通过：返回修好的译文 + 一条 recovered',
    fixed === 'bkb need 200 gold' &&
      recovered.length === 1 &&
      recovered[0].outcome === 'recovered' &&
      recovered[0].tokens.join(',') === 'bkb,200' &&
      recovered[0].retryTokens.length === 0,
    JSON.stringify(recovered[0] ?? null)
  )

  // ---- 违例 + 重试仍坏：gaveup，退回原文（调用方按「译文 === 原文」处理）----
  const gaveUp: GuardEvent[] = []
  const fell = await guardedTranslate(
    'bkb还差200块钱',
    'bkg need money',
    'zh-en',
    'direct',
    async () => 'bkg need money',
    (item) => gaveUp.push(item)
  )
  add(
    '重试仍违例：退回原文 + 一条 gaveup',
    fell === 'bkb还差200块钱' &&
      gaveUp.length === 1 &&
      gaveUp[0].outcome === 'gaveup' &&
      gaveUp[0].via === 'direct' &&
      gaveUp[0].retryTokens.includes('bkb'),
    JSON.stringify(gaveUp[0] ?? null)
  )

  // ---- 投递出口自己炸了，不能反过来毁掉译文 ----
  const survived = await guardedTranslate(
    'bkb还差200块钱',
    'bkg need 200',
    'zh-en',
    'session',
    async () => 'bkb need 200 gold',
    () => {
      throw new Error('sink exploded')
    }
  )
  add('投递抛错：译文照常返回（遥测只丢一条计数）', survived === 'bkb need 200 gold', survived)

  // ---- 三段口径 ----
  const tally = summarizeGuardEvents([
    event(),
    event({ outcome: 'gaveup', tokens: ['bkb', 'tp'], retryTokens: ['bkb'] }),
    event({ tokens: ['tp'] })
  ])
  add(
    '三段计数：blocked=3 / recovered=2 / gaveUp=1',
    tally.blocked === 3 && tally.recovered === 2 && tally.gaveUp === 1,
    JSON.stringify({ b: tally.blocked, r: tally.recovered, g: tally.gaveUp })
  )
  add(
    'token 按次数降序、同次数按名字排',
    tally.tokens[0].token === 'bkb' &&
      tally.tokens[0].count === 2 &&
      tally.tokens[1].token === 'tp' &&
      tally.tokens[1].count === 2,
    JSON.stringify(tally.tokens)
  )
  add('零事件：三段全零（空文件不能伪装成有数据）', (() => {
    const empty = summarizeGuardEvents([])
    return empty.blocked === 0 && empty.recovered === 0 && empty.gaveUp === 0 && empty.tokens.length === 0
  })())

  // ---- 脏行：进程被 kill 时写一半的行必须被丢掉，不能带塌整份汇总 ----
  add('半行 JSON 解析为 null', parseGuardEvent('{"at":"2026-11-20","via":"sess') === null)
  add('空行解析为 null', parseGuardEvent('   ') === null)
  add('缺 outcome 解析为 null', parseGuardEvent('{"at":"2026-11-20","via":"session","tokens":[]}') === null)
  const dirtyLog = [JSON.stringify(event()), '{"at":"cut', JSON.stringify(event({ tokens: ['tp'] }))].join('\n')
  const dirtyTally = summarizeGuardLog(dirtyLog)
  add('整份 jsonl 含一条截断行仍算得对', dirtyTally.blocked === 2 && dirtyTally.tokens.length === 2, `blocked=${dirtyTally.blocked}`)

  // ---- 攒批写盘：一次 append 落多行，且每行仍是完整 JSON ----
  const dir = mkdtempSync(join(app.getPath('temp'), 'translate-guard-'))
  try {
    const file = join(dir, 'batch.jsonl')
    appendCappedJsonlMany(file, [event(), event({ tokens: ['tp'] }), event({ outcome: 'gaveup' })])
    const lines = readFileSync(file, 'utf8').trim().split('\n')
    const fromDisk = summarizeGuardLog(readFileSync(file, 'utf8'))
    add(
      'appendCappedJsonlMany：三行一次写、每行完整可解析',
      lines.length === 3 && lines.every((line) => parseGuardEvent(line) !== null),
      `lines=${lines.length}`
    )
    add('落盘后重算口径与原事件一致', fromDisk.blocked === 3 && fromDisk.recovered === 2 && fromDisk.gaveUp === 1, JSON.stringify({ b: fromDisk.blocked, g: fromDisk.gaveUp }))

    const capped = join(dir, 'capped.jsonl')
    appendCappedJsonlMany(capped, Array.from({ length: 40 }, () => event({ tokens: ['x'.repeat(40)] })), 600)
    const cappedLines = readFileSync(capped, 'utf8').trim().split('\n')
    add(
      '一批超过上限：整份清空重写，不越过上限，且最后一批仍在',
      statSync(capped).size <= 600 && cappedLines.every((line) => parseGuardEvent(line) !== null),
      `bytes=${statSync(capped).size} lines=${cappedLines.length}`
    )
    add('空批不建文件', (() => {
      const empty = join(dir, 'empty.jsonl')
      appendCappedJsonlMany(empty, [])
      try {
        statSync(empty)
        return false
      } catch {
        return true
      }
    })())
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  const failed = checks.filter((item) => !item.ok)
  console.log(
    'TRANSLATE_GUARD_PROBE',
    JSON.stringify({ ok: failed.length === 0, passed: checks.length - failed.length, failed: failed.length })
  )
  for (const item of checks) {
    console.log(`  ${item.ok ? 'ok  ' : 'FAIL'} ${item.name}${item.detail ? `  (${item.detail})` : ''}`)
  }
  exitProbe(failed.length === 0)
}
