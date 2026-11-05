import { toPrintableAscii } from '@shared/chat-line'
import scriptSource from './chat-send.ps1?raw'
import { PsSerial, runPs, writePsArg } from './ps-runner'

// 粘贴是一次按键，整段交接几百毫秒就够；超时给宽一点是因为 PowerShell 启动本身要两百毫秒。
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
 * 把一句英文送进 Dota 2 聊天框：Esc 清草稿、Enter 开框、Ctrl+V 粘贴、Enter 发送。
 * 聊天控件接受真实粘贴，所以不用逐字敲。
 */
class ChatSender {
  private serial = new PsSerial()

  send(text: string): Promise<ChatSendResult> {
    return this.serial.run(() =>
      runPs({
        folder: 'chat-send',
        scriptName: 'chat-send.ps1',
        source: scriptSource,
        args: ['-TextFile', writePsArg('chat-send', 'line.txt', text)],
        timeoutMs: SEND_TIMEOUT_MS,
        timeoutMessage: '聊天框发送超时',
        reasons: EXIT_REASONS,
        noHandshake: '聊天框没有确认收到消息'
      })
    )
  }
}

let sender: ChatSender | null = null

export function getChatSender(): ChatSender {
  if (!sender) sender = new ChatSender()
  return sender
}

/** 聊天框按纯文本对待，只有可打印 ASCII 能完整走完这一趟。 */
export function normalizeChatLine(text: string): string {
  return toPrintableAscii(text)
}
