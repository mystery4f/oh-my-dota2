import { app } from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import scriptSource from './console-send.ps1?raw'

// Typing runs at roughly 50ms per character, so a full 80-char reply needs a wide budget.
const SEND_TIMEOUT_MS = 20_000

export interface ConsoleSendResult {
  ok: boolean
  error?: string
}

/**
 * Types one console command into Dota 2: Esc clears the chat box, the console key
 * opens the console, every character is sent as a real key press, Enter runs it.
 * The Source 2 console ignores clipboard paste, so Ctrl+V cannot be used.
 */
class ConsoleSender {
  private scriptPath: string | null = null
  private chain: Promise<ConsoleSendResult> = Promise.resolve({ ok: true })

  send(command: string, consoleKey: string): Promise<ConsoleSendResult> {
    // Serialize: two hotkeys in a row must not interleave their keystrokes.
    const next = (): Promise<ConsoleSendResult> => this.run(command, consoleKey)
    this.chain = this.chain.then(next, next)
    return this.chain
  }

  private dir(): string {
    const path = join(app.getPath('userData'), 'console-send')
    mkdirSync(path, { recursive: true })
    return path
  }

  private deployScript(): string {
    const path = join(this.dir(), 'console-send.ps1')
    if (this.scriptPath !== path) {
      writeFileSync(path, scriptSource, 'utf8')
      this.scriptPath = path
    }
    return path
  }

  private async run(command: string, consoleKey: string): Promise<ConsoleSendResult> {
    const dir = this.dir()
    const textPath = join(dir, 'command.txt')
    const keyPath = join(dir, 'console-key.txt')
    writeFileSync(textPath, command, 'utf8')
    writeFileSync(keyPath, consoleKey || '\\', 'utf8')

    const scriptPath = this.deployScript()
    return await new Promise<ConsoleSendResult>((resolve) => {
      let settled = false
      const finish = (result: ConsoleSendResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }

      const child = spawn(
        'powershell.exe',
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-File',
          scriptPath,
          '-TextFile',
          textPath,
          '-KeyFile',
          keyPath
        ],
        { windowsHide: true }
      )

      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill()
        finish({ ok: false, error: '控制台发送超时' })
      }, SEND_TIMEOUT_MS)

      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.on('error', (error) => finish({ ok: false, error: error.message }))
      child.on('close', (code) => {
        if (code !== 0) {
          finish({ ok: false, error: describeExit(stdout, stderr, code) })
          return
        }
        if (!stdout.includes('OK')) {
          finish({ ok: false, error: (stderr.trim() || '控制台没有确认收到命令').slice(0, 300) })
          return
        }
        finish({ ok: true })
      })
    })
  }
}

const EXIT_REASONS: Record<string, string> = {
  EMPTY: '命令为空',
  NOGAME: '没有找到 Dota 2 进程',
  NOFOCUS: '没能把游戏窗口切到前台',
  BADKEY: '控制台开关键无法识别'
}

function describeExit(stdout: string, stderr: string, code: number | null): string {
  const token = Object.keys(EXIT_REASONS).find((key) => stdout.includes(key))
  if (token) return EXIT_REASONS[token]
  return (stderr.trim() || `PowerShell 退出码 ${code ?? -1}`).slice(0, 300)
}

let sender: ConsoleSender | null = null

export function getConsoleSender(): ConsoleSender {
  if (!sender) sender = new ConsoleSender()
  return sender
}

/**
 * Build the console command. The console is typed character by character, so the
 * payload is reduced to printable ASCII: quotes, newlines and CJK break it.
 */
export function buildSayTeamCommand(text: string): string {
  const cleaned = text
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/["]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return `say_team "${cleaned}"`
}
