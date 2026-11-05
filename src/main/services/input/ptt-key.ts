import scriptSource from './ptt-key.ps1?raw'
import { PsSerial, runPs } from './ps-runner'

// 按下/松开必须落在 200ms 的头尾余量里，而 PowerShell 启动自己就要两百毫秒。
const KEY_TIMEOUT_MS = 4000

export interface PttKeyResult {
  ok: boolean
  error?: string
}

/**
 * 用原始 SendInput 按下/松开游戏的说话键（一次进程一个事件：键要一直按住整段播放，
 * 单次「敲一下」的脚本做不到）。串行执行——一对按下/松开不能和下一对的按键交错。
 */
class PttKeySender {
  private serial = new PsSerial()

  /** 按下并按住（VK 码）。 */
  down(vk: number): Promise<PttKeyResult> {
    return this.enqueue('down', vk)
  }

  /** 松开（VK 码）。按下失败也必须跑。 */
  up(vk: number): Promise<PttKeyResult> {
    return this.enqueue('up', vk)
  }

  private enqueue(action: 'down' | 'up', vk: number): Promise<PttKeyResult> {
    return this.serial.run(() =>
      runPs({
        folder: 'ptt-key',
        scriptName: 'ptt-key.ps1',
        source: scriptSource,
        args: ['-Vk', String(vk), '-Action', action],
        timeoutMs: KEY_TIMEOUT_MS,
        timeoutMessage: `说话键${action === 'down' ? '按下' : '松开'}超时`,
        noHandshake: '说话键注入未确认',
        // 脚本没有原因表：退出码兜底也要说是哪件事失败了，别让用户只看到「PowerShell 退出码 1」。
        errorPrefix: '说话键注入失败'
      })
    )
  }
}

let sender: PttKeySender | null = null

export function getPttKeySender(): PttKeySender {
  if (!sender) sender = new PttKeySender()
  return sender
}
