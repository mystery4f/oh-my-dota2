import { app } from 'electron'
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * 跑一次 PowerShell 桥：部署脚本、落参数文件、掐超时、认 OK 握手、把退出码翻成人话。
 *
 * 这套骨架此前在 chat-inplace / ptt-key 的前身（chat-send / console-send，已删除）各抄了一遍，差别只在超时数字和提示文案——
 * 连「子进程结束前必须先判断 this.child === child」这种坑都要在三个地方各记一次。
 * 现在只有这一份：参数由调用方写进 `args`，语义差异（原因表、超时说什么）由选项表达。
 */
export interface PsRunOptions {
  /** 数据目录下的子目录名，脚本与参数文件都落在这里 */
  folder: string
  /** 脚本文件名，例如 chat-inplace.ps1 */
  scriptName: string
  /** `?raw` 导入的脚本正文（部署目录里的 .ps1 必须是纯 ASCII） */
  source: string
  /** 传给脚本的参数（参数文件的绝对路径由调用方用 writePsArg 生成） */
  args: string[]
  timeoutMs: number
  /** 超时说的人话，例如「聊天框发送超时」 */
  timeoutMessage: string
  /** 脚本以非零码退出时，stdout 里出现的标记 → 人话 */
  reasons?: Record<string, string>
  /** 没有 OK 握手时说的人话 */
  noHandshake: string
  /** 退出码兜底文案的前缀，例如「说话键注入失败」 */
  errorPrefix?: string
}

export interface PsRunResult {
  ok: boolean
  error?: string
}

/** 已部署过的脚本路径：同一进程内同一个路径只写一次。 */
const deployed = new Set<string>()

function folderPath(folder: string): string {
  const path = join(app.getPath('userData'), folder)
  mkdirSync(path, { recursive: true })
  return path
}

/** 部署脚本，返回落地路径。 */
export function deployPsScript(options: Pick<PsRunOptions, 'folder' | 'scriptName' | 'source'>): string {
  const path = join(folderPath(options.folder), options.scriptName)
  if (!deployed.has(path)) {
    writeFileSync(path, options.source, 'utf8')
    deployed.add(path)
  }
  return path
}

/** 写一个参数文件（文本/键名/内容都走它，避免 CJK 进命令行被代码页吃掉）。 */
export function writePsArg(folder: string, name: string, content: string): string {
  const path = join(folderPath(folder), name)
  writeFileSync(path, content, 'utf8')
  return path
}

/**
 * 串行执行：连按两个热键时，键序不能交错。
 *
 * 一个实例一条链；前一个任务失败也要接着跑下一个（`then(next, next)`）。
 */
export class PsSerial {
  private tail: Promise<unknown> = Promise.resolve()

  run<T>(task: () => Promise<T>): Promise<T> {
    const next = (): Promise<T> => task()
    this.tail = this.tail.then(next, next)
    return this.tail as Promise<T>
  }
}

export function runPs(options: PsRunOptions): Promise<PsRunResult> {
  const scriptPath = deployPsScript(options)
  return new Promise<PsRunResult>((resolve) => {
    let settled = false
    const finish = (result: PsRunResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const child = spawn(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', scriptPath, ...options.args],
      { windowsHide: true }
    )

    let stdout = ''
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      finish({ ok: false, error: options.timeoutMessage })
    }, options.timeoutMs)

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })
    child.on('error', (error) => finish({ ok: false, error: error.message }))
    child.on('close', (code) => {
      if (code !== 0) {
        const token = Object.keys(options.reasons ?? {}).find((key) => stdout.includes(key))
        if (token && options.reasons) {
          finish({ ok: false, error: options.reasons[token] })
          return
        }
        const detail = (stderr.trim() || `PowerShell 退出码 ${code ?? -1}`).slice(0, 300)
        finish({ ok: false, error: options.errorPrefix ? `${options.errorPrefix}：${detail}` : detail })
        return
      }
      if (!stdout.includes('OK')) {
        finish({ ok: false, error: (stderr.trim() || options.noHandshake).slice(0, 300) })
        return
      }
      finish({ ok: true })
    })
  })
}
