import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { locateWorkerScript, voiceRuntimeNodeBinary, voiceWorkerEnv } from './runtime'
/**
 * 常驻语音 worker 的 NDJSON 进程协议，收口在这一个 harness 里：spawn 参数、
 * 行缓冲（半行丢弃）、id 派发、单请求超时、close 的迟到退场守卫（旧进程的 close
 * 不得清掉新引用——这条血泪规则以前靠两个调用方各自记得，现在是结构）、
 * fail-all-pending。调用方只声明脚本名、超时和日志标签。
 */
export interface NdjsonWorkerOptions {
  /** resources 下的 worker 脚本名；绝对路径直接使用（探针注入假 worker 用）。 */
  script: string
  /** 单次请求超时毫秒；超时按 `{ ok: false, err: 'timeout' }` 结算，worker 本身不杀。 */
  timeoutMs: number
  /** 日志前缀：NO_NODE / WORKER_MISSING / STDERR / EXIT 都挂在这下面，如 'ASR_SHERPA'。 */
  tag: string
}

/** worker 回复的公共形状；具体字段（text 等）由调用方声明自己的回复类型。 */
export interface NdjsonReply {
  ok: boolean
  err?: string
}

export interface NdjsonWorker<TReply extends NdjsonReply> {
  /** 发一次请求：payload 不带 id，harness 负责编号与配对。 */
  request(payload: Record<string, unknown>): Promise<TReply>
  /** 杀掉常驻进程：换模型后旧引擎连着旧文件，杀掉后下一次请求重新拉起。 */
  reset(): void
}

export function createNdjsonWorker<TReply extends NdjsonReply>(options: NdjsonWorkerOptions): NdjsonWorker<TReply> {
  let worker: ChildProcess | null = null
  let seq = 0
  const pending = new Map<number, (reply: TReply) => void>()

  function ensureWorker(): ChildProcess {
    if (worker && !worker.killed) return worker
    const script = isAbsolute(options.script) ? options.script : locateWorkerScript(options.script)
    if (!existsSync(script)) throw new Error(`${options.tag}_WORKER_MISSING ${script}`)
    const node = voiceRuntimeNodeBinary()
    if (!node) throw new Error(`${options.tag}_NO_NODE`)
    const child = spawn(node, [script], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: voiceWorkerEnv()
    })
    let buffer = ''
    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => {
      buffer += chunk
      let index = buffer.indexOf('\n')
      while (index >= 0) {
        const line = buffer.slice(0, index)
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        try {
          const reply = JSON.parse(line) as TReply & { id: number }
          const done = pending.get(reply.id)
          pending.delete(reply.id)
          done?.(reply)
        } catch {
          // 半行或噪声，丢掉。
        }
      }
    })
    child.stderr?.on('data', (chunk: Buffer) => {
      console.log(`${options.tag}_WORKER_STDERR`, JSON.stringify({ text: String(chunk).trim().slice(0, 300) }))
    })
    child.on('close', (code) => {
      console.log(`${options.tag}_WORKER_EXIT`, JSON.stringify({ code }))
      // 迟到退场守卫：只有当前引用还是这个 child 才清状态，老进程的 close 不许动新引用。
      if (worker === child) worker = null
      for (const done of pending.values()) done({ ok: false, err: 'worker exited' } as TReply)
      pending.clear()
    })
    worker = child
    return child
  }

  return {
    async request(payload: Record<string, unknown>): Promise<TReply> {
      const child = ensureWorker()
      const id = ++seq
      return await new Promise<TReply>((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id)
          resolve({ ok: false, err: 'timeout' } as TReply)
        }, options.timeoutMs)
        pending.set(id, (value) => {
          clearTimeout(timer)
          resolve(value)
        })
        child.stdin?.write(`${JSON.stringify({ id, ...payload })}\n`)
      })
    },
    reset(): void {
      if (worker && !worker.killed) worker.kill()
      worker = null
    }
  }
}
