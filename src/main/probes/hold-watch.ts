import { exitProbe } from './harness'
import { spawn } from 'node:child_process'
import { stopHoldWatch, watchHold } from '../services/input/hotkey-hold'

interface Case {
  name: string
  ok: boolean
  detail: string
}

/**
 * 按住监视探针（--hold-watch-probe）：真的按下、真的松开，不开窗口、不碰麦克风。
 *
 * 这条链路是「按住说话」的全部地基：globalShortcut 拿不到松开，所以信号来自一个常驻
 * PowerShell 轮询 GetAsyncKeyState。规则自洽不代表信号真的会来，这里用 keybd_event 注入
 * 一次 300ms 按住和一次 120ms 轻敲，要求每条边只出现一次、顺序正确。
 *
 * VK 用 F13（0x7C）：没有键盘有这个键，注入它不会惊动浏览器或游戏。
 */
export function runHoldWatchProbe(): void {
  const cases: Case[] = []
  const push = (name: string, ok: boolean, detail: string): void => {
    cases.push({ name, ok, detail })
  }

  const events: string[] = []
  const started = Date.now()
  watchHold([0x7c], {
    onPress: () => events.push('press'),
    onRelease: () => events.push('release')
  })

  let done = false
  function finish(exitCode: number | null, stderr: string): void {
    if (done) return
    done = true
    push(
      '注入进程正常退出',
      exitCode === 0,
      JSON.stringify({ exitCode, stderr: stderr.trim() || undefined, elapsedMs: Date.now() - started })
    )
    push(
      '按住 300ms 产生一按一放',
      JSON.stringify(events.slice(0, 2)) === JSON.stringify(['press', 'release']),
      JSON.stringify(events)
    )
    push('轻敲 120ms 也能被捕获', JSON.stringify(events.slice(2)) === JSON.stringify(['press', 'release']), JSON.stringify(events.slice(2)))
    push('长按期间不重复触发', events.filter((item) => item === 'press').length === 2, `press=${events.filter((item) => item === 'press').length}`)
    stopHoldWatch()
    const failed = cases.filter((item) => !item.ok)
    for (const item of cases) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name} ${item.detail}`)
    console.log(
      `HOLD_WATCH_PROBE ${JSON.stringify({ ok: failed.length === 0, passed: cases.length - failed.length, failed: failed.length })}`
    )
    exitProbe(!(failed.length > 0 ))
  }

  // 常驻进程是异步拉起的：先等 READY（PowerShell 冷启动 + Add-Type 约 1–2 s），
  // 早于它就按键会被完全漏掉，测出来的「没反应」是假阴性。
  setTimeout(() => {
    const script = [
      'Add-Type -Namespace W -Name K -MemberDefinition \'[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);\'',
      '[W.K]::keybd_event(0x7C,0,0,[System.UIntPtr]::Zero)',
      'Start-Sleep -Milliseconds 300',
      '[W.K]::keybd_event(0x7C,0,2,[System.UIntPtr]::Zero)',
      'Start-Sleep -Milliseconds 400',
      '[W.K]::keybd_event(0x7C,0,0,[System.UIntPtr]::Zero)',
      'Start-Sleep -Milliseconds 120',
      '[W.K]::keybd_event(0x7C,0,2,[System.UIntPtr]::Zero)'
    ].join('; ')
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      windowsHide: true
    })
    let stderr = ''
    child.stderr?.on('data', (chunk) => {
      stderr = (stderr + String(chunk)).slice(-500)
    })
    child.on('close', (code) => {
      // 最后一次松开还要一拍轮询才落定。
      setTimeout(() => finish(code, stderr), 300)
    })
    child.on('error', (error) => {
      push('注入进程启动失败', false, error.message)
      finish(null, '')
    })
  }, 3000)
}
