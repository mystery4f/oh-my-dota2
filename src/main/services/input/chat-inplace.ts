import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import script from './chat-inplace.ps1?raw'

const READY_TIMEOUT_MS = 20_000
const REQUEST_TIMEOUT_MS = 15_000

const EXIT_REASONS: Record<string, string> = {
  EMPTY: '译文为空',
  NOGAME: '没有找到 Dota 2 进程',
  NOFOCUS: '游戏不在前台：先把 Dota 2 切到前台再按热键',
  NOCONTENT: '没有读到聊天框内容：先在游戏里按 Enter 打开聊天框并打中文',
  BADOP: '未知的输入请求'
}

const LOG_MAX_BYTES = 200_000

/** 逐段计时落盘：用户只说「等好久」时总耗时无法定位，必须知道慢在查进程、写剪贴板还是按键。 */
function appendLog(line: string): void {
  try {
    const dir = join(app.getPath('userData'), 'logs')
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'inplace.log')
    try {
      if (statSync(file).size > LOG_MAX_BYTES) writeFileSync(file, '')
    } catch {
      // 首次写：文件还不存在。
    }
    appendFileSync(file, new Date().toISOString() + ' ' + line + '\n')
  } catch {
    // 日志失败不能影响直发本身。
  }
}

interface BridgeResponse {
  ok: boolean
  text?: string
  error?: string
  /** 分段计时：Get-Process 找窗口、写剪贴板、发组合键。 */
  lookupMs?: number
  clipSetMs?: number
  keysMs?: number
  /** 首轮组合键被丢、走慢速重试时为 true（正常应为 false）。 */
  retried?: boolean
  /** NOFOCUS 时回传当前前台句柄与目标句柄，便于定位「谁抢了焦点」。 */
  fg?: number
  win?: number
  /** focus op: 游戏进程在不在、是不是它占着前台。 */
  gameRunning?: boolean
  focused?: boolean
  /** focus op 的诊断：前台窗口属于哪个进程、游戏窗口句柄是多少。 */
  fgPid?: number
}

function timingOf(res: BridgeResponse): string {
  return (
    'lookup=' + (res.lookupMs ?? '-') +
    ' clip=' + (res.clipSetMs ?? '-') +
    ' keys=' + (res.keysMs ?? '-') +
    (res.retried ? ' retried' : '') +
    (res.fg === undefined ? '' : ' fg=' + res.fg) +
    (res.win === undefined ? '' : ' win=' + res.win)
  )
}

export interface GrabResult extends BridgeResponse {
  ms?: number
}

/** 前台探测的答案。fg/fgPid/win 只用于排查「为什么判成不在前台」。 */
export interface FocusState {
  gameRunning: boolean
  focused: boolean
  fgPid?: number
  fg?: number
  win?: number
}

export interface ReplaceResult extends BridgeResponse {
  ms?: number
}

interface Pending {
  resolve: (value: BridgeResponse) => void
  timer: NodeJS.Timeout
}

/**
 * 游戏输入常驻桥：一个 PowerShell 进程同时负责「读聊天框草稿」与「粘回英文并回车」。
 * 之所以常驻，是因为每次 spawn 加 Add-Type 编译要 600–680ms，而一次直发要两次往返。
 */
class InPlaceBridge {
  private child: ChildProcessWithoutNullStreams | null = null
  private ready = false
  private starting: Promise<void> | null = null
  private buffer = ''
  private seq = 0
  private pending = new Map<number, Pending>()
  private chain: Promise<unknown> = Promise.resolve()
  private lastError: string | null = null
  private startedAt = 0

  private dir(): string {
    return join(app.getPath('userData'), 'chat-inplace')
  }

  private scriptPath(): string {
    return join(this.dir(), 'chat-inplace.ps1')
  }

  private deploy(): void {
    mkdirSync(this.dir(), { recursive: true })
    if (!existsSync(this.scriptPath()) || readFileSync(this.scriptPath(), 'utf8') !== script) {
      writeFileSync(this.scriptPath(), script, 'utf8')
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim()
    if (!trimmed) return
    let payload: {
      event?: string
      id?: number
      ok?: boolean
      text?: string
      code?: string
      lookupMs?: number
      clipSetMs?: number
      keysMs?: number
      retried?: boolean
      fg?: number
      win?: number
      gameRunning?: boolean
      focused?: boolean
      fgPid?: number
    }
    try {
      payload = JSON.parse(trimmed) as typeof payload
    } catch {
      return
    }
    if (payload.event === 'ready') {
      this.ready = true
      if (this.startedAt) appendLog('bridge ready ' + (Date.now() - this.startedAt) + 'ms')
      this.startedAt = 0
      return
    }
    const id = payload.id
    if (typeof id !== 'number') return
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    clearTimeout(entry.timer)
    if (payload.ok)
      entry.resolve({
        ok: true,
        text: payload.text,
        lookupMs: payload.lookupMs,
        clipSetMs: payload.clipSetMs,
        keysMs: payload.keysMs,
        retried: payload.retried,
        // focus op 的答案也必须透传：白名单漏掉这几个字段，闸门就会永远以为「不在前台」。
        gameRunning: payload.gameRunning,
        focused: payload.focused,
        fgPid: payload.fgPid,
        fg: payload.fg,
        win: payload.win
      })
    else
      entry.resolve({
        ok: false,
        error: EXIT_REASONS[payload.code ?? ''] ?? `输入桥失败：${payload.code ?? 'unknown'}`,
        lookupMs: payload.lookupMs,
        fg: payload.fg,
        win: payload.win
      })
  }

  private failAll(message: string): void {
    this.lastError = message
    this.ready = false
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      this.pending.delete(id)
      entry.resolve({ ok: false, error: message })
    }
  }

  private ensureStarted(): Promise<void> {
    if (this.child && this.ready) return Promise.resolve()
    if (this.starting) return this.starting
    this.deploy()
    appendLog('bridge start')
    this.startedAt = Date.now()
    this.starting = new Promise<void>((resolve, reject) => {
      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.scriptPath()],
        { windowsHide: true }
      )
      this.child = child
      this.ready = false
      this.buffer = ''
      let settled = false
      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        child.kill()
        reject(new Error('游戏输入桥启动超时'))
      }, READY_TIMEOUT_MS)
      const finish = (error?: Error): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
      const poll = setInterval(() => {
        if (this.ready) {
          clearInterval(poll)
          finish()
        }
      }, 50)
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk: string) => {
        this.buffer += chunk
        let index = this.buffer.indexOf('\n')
        while (index >= 0) {
          const line = this.buffer.slice(0, index)
          this.buffer = this.buffer.slice(index + 1)
          this.handleLine(line)
          index = this.buffer.indexOf('\n')
        }
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk: string) => {
        this.lastError = chunk.toString().slice(0, 400)
      })
      child.on('error', (error) => {
        // 旧进程的退出事件可能在新进程已经起来之后才到，别把新进程的引用清掉。
        if (this.child !== child) return
        clearInterval(poll)
        this.child = null
        finish(error)
      })
      child.on('close', () => {
        if (this.child !== child) return
        clearInterval(poll)
        this.child = null
        this.starting = null
        this.failAll('游戏输入桥已退出')
        finish(new Error('游戏输入桥已退出'))
      })
    }).finally(() => {
      this.starting = null
    })
    return this.starting
  }

  private request(op: 'grab' | 'send' | 'ping' | 'focus', text?: string): Promise<BridgeResponse> {
    return new Promise((resolve) => {
      const child = this.child
      if (!child || !this.ready) {
        resolve({ ok: false, error: this.lastError ?? '游戏输入桥未启动' })
        return
      }
      const id = ++this.seq
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ ok: false, error: '游戏输入超时' })
      }, REQUEST_TIMEOUT_MS)
      this.pending.set(id, { resolve, timer })
      child.stdin.write(JSON.stringify({ id, op, text }) + '\n')
    })
  }

  async prewarm(): Promise<void> {
    await this.ensureStarted().catch(() => undefined)
  }

  /** 只测桥的往返延迟，不碰游戏窗口。 */
  async ping(): Promise<{ ok: boolean; readyMs: number; ms: number }> {
    const startedAt = Date.now()
    await this.ensureStarted()
    const readyMs = Date.now() - startedAt
    const res = await this.request('ping')
    return { ok: res.ok, readyMs, ms: Date.now() - startedAt }
  }

  /**
   * 游戏是否在前台：抓屏循环的廉价闸门，省掉「对着浏览器窗口 OCR」的空转。
   * 桥起不来或查询失败时返回 null，由调用方按「在前台」放行——闸门坏了不能反过来把捕获关死。
   */
  async focus(): Promise<FocusState | null> {
    await this.ensureStarted().catch(() => undefined)
    const res = await this.request('focus')
    if (!res.ok) return null
    // 守卫：答案里没有 gameRunning 说明字段在解析层被吃掉了（2026-11 踩过一次，闸门静默永远关着）。
    if (res.gameRunning === undefined) appendLog('focus malformed ' + JSON.stringify(res))
    return {
      gameRunning: res.gameRunning === true,
      focused: res.focused === true,
      fgPid: res.fgPid,
      fg: res.fg,
      win: res.win
    }
  }

  grab(): Promise<GrabResult> {
    const next = this.chain.then(async (): Promise<GrabResult> => {
      const startedAt = Date.now()
      try {
        await this.ensureStarted()
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - startedAt }
      }
      const res = await this.request('grab')
      const ms = Date.now() - startedAt
      appendLog('grab ' + (res.ok ? 'ok' : 'fail') + ' ' + ms + 'ms ' + timingOf(res) + (res.ok ? '' : ' ' + (res.error ?? '')))
      if (!res.ok) return { ...res, ok: false, error: res.error, ms }
      const text = (res.text ?? '').trim()
      if (!text) return { ...res, ok: false, error: '聊天框里没有可翻译的内容', ms }
      return { ...res, ok: true, text, ms }
    })
    this.chain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  replace(text: string): Promise<ReplaceResult> {
    const next = this.chain.then(async (): Promise<ReplaceResult> => {
      const startedAt = Date.now()
      try {
        await this.ensureStarted()
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err), ms: Date.now() - startedAt }
      }
      const res = await this.request('send', text)
      const ms = Date.now() - startedAt
      appendLog('send ' + (res.ok ? 'ok' : 'fail') + ' ' + ms + 'ms ' + timingOf(res) + (res.ok ? '' : ' ' + (res.error ?? '')))
      return { ...res, ms }
    })
    this.chain = next.then(
      () => undefined,
      () => undefined
    )
    return next
  }

  dispose(): void {
    this.child?.kill()
    this.child = null
    this.ready = false
  }
}

let bridge: InPlaceBridge | null = null

export function getInPlaceSender(): InPlaceBridge {
  if (!bridge) bridge = new InPlaceBridge()
  return bridge
}
