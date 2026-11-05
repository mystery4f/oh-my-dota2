import { toPrintableAscii } from '@shared/chat-line'
import scriptSource from './console-send.ps1?raw'
import { PsSerial, runPs, writePsArg } from './ps-runner'

// 逐字打字约 50ms 一个字，80 字的回复要留足预算。
const SEND_TIMEOUT_MS = 20_000

export interface ConsoleSendResult {
  ok: boolean
  error?: string
}

const EXIT_REASONS: Record<string, string> = {
  EMPTY: '命令为空',
  NOGAME: '没有找到 Dota 2 进程',
  NOFOCUS: '没能把游戏窗口切到前台',
  BADKEY: '控制台开关键无法识别'
}

/**
 * 把一条控制台命令打进 Dota 2：Esc 清聊天框、开关键调出控制台、逐字真按键、Enter 执行。
 * Source 2 控制台不认粘贴，所以 Ctrl+V 那条路在这里用不了。
 */
class ConsoleSender {
  private serial = new PsSerial()

  send(command: string, consoleKey: string): Promise<ConsoleSendResult> {
    return this.serial.run(() =>
      runPs({
        folder: 'console-send',
        scriptName: 'console-send.ps1',
        source: scriptSource,
        args: [
          '-TextFile',
          writePsArg('console-send', 'command.txt', command),
          '-KeyFile',
          writePsArg('console-send', 'console-key.txt', consoleKey || '\\')
        ],
        timeoutMs: SEND_TIMEOUT_MS,
        timeoutMessage: '控制台发送超时',
        reasons: EXIT_REASONS,
        noHandshake: '控制台没有确认收到命令'
      })
    )
  }
}

let sender: ConsoleSender | null = null

export function getConsoleSender(): ConsoleSender {
  if (!sender) sender = new ConsoleSender()
  return sender
}

/** 控制台是逐字打进去的，只留可打印 ASCII：引号会把命令截断，CJK 和换行会变空。 */
export function buildSayTeamCommand(text: string): string {
  return `say_team "${toPrintableAscii(text).replace(/"/g, '')}"`
}
