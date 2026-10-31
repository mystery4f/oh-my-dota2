import { app } from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import scriptSource from './ptt-key.ps1?raw'

// Press/release must reach the game within the 200ms lead/tail margins,
// and PowerShell startup itself eats a couple hundred ms.
const KEY_TIMEOUT_MS = 4000

export interface PttKeyResult {
  ok: boolean
  error?: string
}

/**
 * Sends the game push-to-talk key as raw SendInput down/up events (one process
 * per event: the key must stay HELD for the whole playback, so a single
 * "tap" script will not do). Serialized — a down/up pair must never interleave
 * with the next test run's pair.
 */
class PttKeySender {
  private scriptPath: string | null = null
  private chain: Promise<PttKeyResult> = Promise.resolve({ ok: true })

  /** Press and hold the key (VK code). */
  down(vk: number): Promise<PttKeyResult> {
    return this.enqueue('down', vk)
  }

  /** Release the key (VK code). Must always run — even after a failed down. */
  up(vk: number): Promise<PttKeyResult> {
    return this.enqueue('up', vk)
  }

  private enqueue(action: 'down' | 'up', vk: number): Promise<PttKeyResult> {
    const next = (): Promise<PttKeyResult> => this.run(action, vk)
    this.chain = this.chain.then(next, next)
    return this.chain
  }

  private deployScript(): string {
    const path = join(app.getPath('userData'), 'ptt-key', 'ptt-key.ps1')
    if (this.scriptPath !== path) {
      mkdirSync(join(app.getPath('userData'), 'ptt-key'), { recursive: true })
      writeFileSync(path, scriptSource, 'utf8')
      this.scriptPath = path
    }
    return path
  }

  private run(action: 'down' | 'up', vk: number): Promise<PttKeyResult> {
    const scriptPath = this.deployScript()
    return new Promise<PttKeyResult>((resolve) => {
      let settled = false
      const finish = (result: PttKeyResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve(result)
      }

      const child = spawn(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, '-Vk', String(vk), '-Action', action],
        { windowsHide: true }
      )

      let stdout = ''
      let stderr = ''
      const timer = setTimeout(() => {
        child.kill()
        finish({ ok: false, error: `说话键${action === 'down' ? '按下' : '松开'}超时` })
      }, KEY_TIMEOUT_MS)

      child.stdout?.on('data', (chunk) => {
        stdout += String(chunk)
      })
      child.stderr?.on('data', (chunk) => {
        stderr += String(chunk)
      })
      child.on('error', (error) => finish({ ok: false, error: error.message }))
      child.on('close', (code) => {
        if (code !== 0) {
          finish({ ok: false, error: (stderr.trim() || `PowerShell 退出码 ${code ?? -1}`).slice(0, 300) })
          return
        }
        if (!stdout.includes('OK')) {
          finish({ ok: false, error: (stderr.trim() || '说话键注入未确认').slice(0, 300) })
          return
        }
        finish({ ok: true })
      })
    })
  }
}

let sender: PttKeySender | null = null

export function getPttKeySender(): PttKeySender {
  if (!sender) sender = new PttKeySender()
  return sender
}
