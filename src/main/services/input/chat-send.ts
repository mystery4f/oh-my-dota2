import { app } from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import scriptSource from './chat-send.ps1?raw'

// Paste is a single keystroke, so the whole hand-off fits in a few hundred ms.
const SEND_TIMEOUT_MS = 12_000

export interface ChatSendResult {
  ok: boolean
  error?: string
}

const EXIT_REASONS: Record<string, string> = {
  EMPTY: '内容为空',
  NOGAME: '没有找到 Dota 2 进程',
  NOFOCUS: '没能把游戏窗口切到前台'
}

/**
 * Types a short English line into the Dota 2 chat box: Esc clears any draft,
 * Enter opens the chat box, Ctrl+V pastes the clipboard and Enter sends it.
 * The chat widget accepts a real paste, so nothing is typed character by character.
 */
class ChatSender {
  private scriptPath: string | null = null
  private chain: Promise<ChatSendResult> = Promise.resolve({ ok: true })

  send(text: string): Promise<ChatSendResult> {
    const next = (): Promise<ChatSendResult> => this.run(text)
    this.chain = this.chain.then(next, next)
    return this.chain
  }

  private dir(): string {
    const path = join(app.getPath('userData'), 'chat-send')
    mkdirSync(path, { recursive: true })
    return path
  }

  private deployScript(): string {
    const path = join(this.dir(), 'chat-send.ps1')
    if (this.scriptPath !== path) {
      writeFileSync(path, scriptSource, 'utf8')
      this.scriptPath = path
    }
    return path
  }

  private async run(text: string): Promise<ChatSendResult> {
    const dir = this.dir()
    const textPath = join(dir, 'line.txt')
    writeFileSync(textPath, text, 'utf8')

    const scriptPath = this.deployScript()
    return await new Promise<ChatSendResult>((resolve) => {
      let settled = false
      const finish = (result: ChatSendResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }

      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-TextFile', textPath],
        { windowsHide: true }
      )

      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill()
        finish({ ok: false, error: '聊天框发送超时' })
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
          const token = Object.keys(EXIT_REASONS).find((key) => stdout.includes(key))
          finish({
            ok: false,
            error: token ? EXIT_REASONS[token] : (stderr.trim() || `PowerShell 退出码 ${code ?? -1}`).slice(0, 300)
          })
          return
        }
        if (!stdout.includes('OK')) {
          finish({ ok: false, error: (stderr.trim() || '聊天框没有确认收到消息').slice(0, 300) })
          return
        }
        finish({ ok: true })
      })
    })
  }
}

let sender: ChatSender | null = null

export function getChatSender(): ChatSender {
  if (!sender) sender = new ChatSender()
  return sender
}

/** The chat box is typed as plain text, so only printable ASCII survives the trip. */
export function normalizeChatLine(text: string): string {
  return text
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}
