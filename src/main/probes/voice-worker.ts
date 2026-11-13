import { exitProbe } from './harness'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createNdjsonWorker, type NdjsonReply } from '../services/voice/worker'

/**
 * `--voice-worker-probe`：NDJSON worker 协议 harness（src/main/services/voice/worker.ts）的行为锁。
 * 假 worker（临时目录 .cjs，纯 node，零模型）：回声、并发配对、启动噪声+拆半写、崩溃清算与重启、
 * 超时不卡死后续请求、脚本缺失报错。这些以前只能靠线上踩（两个手写双胞胎零测试），现在全部探针化。
 */
interface Row {
  name: string
  ok: boolean
  detail: string
}
const cases: Row[] = []
function push(name: string, ok: boolean, detail: string): void {
  cases.push({ name, ok, detail })
}

interface FakeReply extends NdjsonReply {
  text?: string
}

/** 假 worker：每条请求的回声都拆成两次 write（钉半行重组），启动先写一行垃圾（钉噪声丢弃）。 */
const FAKE_WORKER_SOURCE = `\
console.log('startup noise, definitely not json')
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
// 回复按请求顺序逐条出（真 worker 的行为），每条拆两次 write 钉半行重组。
let writing = false
const queue = []
function drain() {
  if (writing || !queue.length) return
  writing = true
  const req = queue.shift()
  const payload = JSON.stringify({ id: req.id, ok: true, text: 'echo:' + String(req.text ?? '') })
  process.stdout.write(payload.slice(0, Math.ceil(payload.length / 2)))
  setTimeout(() => {
    process.stdout.write(payload.slice(Math.ceil(payload.length / 2)) + '\\n')
    writing = false
    drain()
  }, 5)
}
rl.on('line', (line) => {
  let req
  try { req = JSON.parse(line) } catch { return }
  if (req.crash) process.exit(1)
  setTimeout(() => { queue.push(req); drain() }, Number(req.delayMs ?? 0))
})
`

function settle(promise: Promise<FakeReply>): Promise<{ ok: boolean; err?: string; text?: string }> {
  return promise.then(
    (reply) => reply,
    (error: unknown) => ({ ok: false, err: error instanceof Error ? error.message : String(error) })
  )
}

export async function runVoiceWorkerProbe(): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'omd2-worker-probe-'))
  try {
    const script = join(dir, 'fake-voice-worker.cjs')
    writeFileSync(script, FAKE_WORKER_SOURCE)

    const worker = createNdjsonWorker<FakeReply>({ script, timeoutMs: 2000, tag: 'WORKER_PROBE' })

    // 回声往返 + 启动噪声 + 拆半写重组
    const echo = await settle(worker.request({ text: 'hello' }))
    push(
      'echo：噪声行丢弃、拆半 JSON 重组、id 配对',
      echo.ok && echo.text === 'echo:hello',
      JSON.stringify(echo)
    )

    // 并发：两个请求在途，各自配对各自的回复
    const [a, b] = await Promise.all([settle(worker.request({ text: 'a' })), settle(worker.request({ text: 'b' }))])
    push(
      'concurrent：两个在途请求不串号',
      a.ok && b.ok && a.text === 'echo:a' && b.text === 'echo:b',
      JSON.stringify({ a, b })
    )

    // 崩溃：在途请求被清算为 worker exited，下一次请求重新拉起进程并成功
    const crashed = await settle(worker.request({ crash: true }))
    const respawned = await settle(worker.request({ text: 'back' }))
    push(
      'crash：清算 + 守卫 + 重启',
      !crashed.ok && crashed.err === 'worker exited' && respawned.ok && respawned.text === 'echo:back',
      JSON.stringify({ crashed, respawned })
    )

    // 超时：短超时实例里慢请求按 timeout 结算且不杀进程，后续快请求照常成功
    const touchy = createNdjsonWorker<FakeReply>({ script, timeoutMs: 200, tag: 'WORKER_PROBE' })
    const slow = await settle(touchy.request({ text: 'slow', delayMs: 800 }))
    const fast = await settle(touchy.request({ text: 'fast', delayMs: 0 }))
    push(
      'timeout：慢请求结算超时，worker 不被拖死',
      !slow.ok && slow.err === 'timeout' && fast.ok && fast.text === 'echo:fast',
      JSON.stringify({ slow, fast })
    )
    touchy.reset()

    worker.reset()

    // 脚本缺失：报 WORKER_MISSING 而不是静默挂起
    const missing = createNdjsonWorker<FakeReply>({ script: 'no-such-worker.cjs', timeoutMs: 2000, tag: 'WORKER_PROBE' })
    const gone = await settle(missing.request({ text: 'x' }))
    push(
      'missing：脚本缺失立即报错',
      !gone.ok && gone.err?.startsWith('WORKER_PROBE_WORKER_MISSING') === true,
      JSON.stringify(gone)
    )
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }

  let failed = 0
  for (const item of cases) {
    if (!item.ok) failed++
    console.log(`${item.ok ? 'PASS' : 'FAIL'} | ${item.name} | ${item.detail}`)
  }
  console.log(`VOICE_WORKER_PROBE ${cases.length - failed}/${cases.length} PASS`)
  exitProbe(!(failed > 0 ))
}
