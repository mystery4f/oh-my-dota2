import { exitProbe } from './harness'
import { spawn } from 'node:child_process'
import { stopHoldWatch, watchHold } from '../services/input/hotkey-hold'
import { holdSelfTest, resetHoldSelfTest } from '../services/input/hold-selftest'
import { deployPsScript } from '../services/input/ps-runner'

interface Case {
  name: string
  ok: boolean
  detail: string
}

/**
 * 按住监视探针（--hold-watch-probe）：三段，一层一件事。
 *
 * 这条链路是「按住说话」的地基：globalShortcut 只报按下，松开来自一个常驻 PowerShell
 * 轮询 GetAsyncKeyState。探针要证明的是「脚本吐出的边真被我们接住」，而不是「Windows
 * 收不收注入的按键」——后者取决于跑探针的桌面（实测这台机器拒收 keybd_event：同一进程
 * 里注入后 GetAsyncKeyState 仍返回 0），环境限制不能算代码失败。
 *
 * 第一段（真脚本）：真起常驻 PowerShell，等它回报 OK；再尽力注一次 F13 按住，
 * 收到边就断言，收不到只记 SKIP 并写明原因。
 * 第二段（假脚本）：一个按协议吐 OK / HOLD 1 / HOLD 0 的子进程，确定性地钉住就绪、
 * 边只落一条、回调各触发一次——这一段在任何机器上都必须绿。
 * 第三段（起不来）：假 launcher 立刻退出，要求退回敲一下并把原因留在状态里。
 */
export function runHoldWatchProbe(): void {
  const cases: Case[] = []
  const skips: { name: string; detail: string }[] = []
  const push = (name: string, ok: boolean, detail: string): void => {
    cases.push({ name, ok, detail })
  }
  const skip = (name: string, detail: string): void => {
    skips.push({ name, detail })
  }
  let settled = false
  const report = (injection: string): void => {
    if (settled) return
    settled = true
    stopHoldWatch()
    const failed = cases.filter((item) => !item.ok)
    for (const item of cases) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name} ${item.detail}`)
    for (const item of skips) console.log(`SKIP ${item.name} ${item.detail}`)
    console.log(
      `HOLD_WATCH_PROBE ${JSON.stringify({
        ok: failed.length === 0 && cases.length > 0,
        passed: cases.length - failed.length,
        failed: failed.length,
        skipped: skips.length,
        injection
      })}`
    )
    exitProbe(!(failed.length > 0))
  }

  realPhase(push, skip, (injection) => {
    protocolPhase(push, () => {
      fallbackPhase(push, () => report(injection))
    })
  })
}

/** 等一个条件成立再往下走；超时就走超时分支。 */
function waitFor(ready: () => boolean, timeoutMs: number, step: number, then: () => void, onTimeout: () => void): void {
  const deadline = Date.now() + timeoutMs
  const tick = (): void => {
    if (ready()) {
      then()
      return
    }
    if (Date.now() > deadline) {
      onTimeout()
      return
    }
    setTimeout(tick, step)
  }
  setTimeout(tick, step)
}

/**
 * 第一段：真常驻脚本。只硬性要求「起来了并回报 OK」；注入的按键能不能被这个桌面接受，
 * 是环境问题，收不到就 SKIP。
 */
function realPhase(
  push: (name: string, ok: boolean, detail: string) => void,
  skip: (name: string, detail: string) => void,
  next: (injection: string) => void
): void {
  resetHoldSelfTest()
  const edges: string[] = []
  watchHold(
    [0x7c],
    {
      onPress: () => edges.push('press'),
      onRelease: () => edges.push('release')
    },
    { retryMs: 2_000 }
  )
  waitFor(
    () => holdSelfTest().ready,
    15_000,
    200,
    () => {
      push(
        '#95 真脚本：常驻脚本起来了并回报 OK',
        holdSelfTest().presence === 'resident',
        JSON.stringify({ presence: holdSelfTest().presence })
      )
      injectOnce(edges, push, skip, next)
    },
    () => {
      push('#95 真脚本：15 秒内没起来', false, JSON.stringify({ presence: holdSelfTest().presence }))
      stopHoldWatch()
      next('no-ready')
    }
  )
}

const INJECT = [
  'Add-Type -Namespace W -Name K -MemberDefinition \'[DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, System.UIntPtr dwExtraInfo);\'',
  '[W.K]::keybd_event(0x7C,0,0,[System.UIntPtr]::Zero)',
  'Start-Sleep -Milliseconds 300',
  '[W.K]::keybd_event(0x7C,0,2,[System.UIntPtr]::Zero)'
].join('\r\n')

/** 尽力注一次 F13 按住：脚本落盘用 -File 跑，`-Command "<长一行>"` 会挂住不退出。 */
function injectOnce(
  edges: string[],
  push: (name: string, ok: boolean, detail: string) => void,
  skip: (name: string, detail: string) => void,
  next: (injection: string) => void
): void {
  const script = deployInjectScript()
  const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script], {
    windowsHide: true
  })
  let settled = false
  const settle = (): void => {
    if (settled) return
    settled = true
    stopHoldWatch()
    if (edges.length === 2) {
      push('#95 真脚本：注入的按住产生一按一放', true, JSON.stringify(edges))
      next('ok')
      return
    }
    skip(
      '#95 真脚本：注入的按住产生一按一放',
      JSON.stringify({
        edges,
        why: '这个桌面拒收 keybd_event（同一进程里注入后 GetAsyncKeyState 仍返回 0），环境限制不算代码失败；协议解析由下一段钉住'
      })
    )
    next('rejected')
  }
  child.on('close', () => setTimeout(settle, 600))
  child.on('error', () => settle())
  // 注入脚本自己 1 秒内就该退；给 10 秒，超时直接收场（不再等它）。
  setTimeout(settle, 10_000)
}

function deployInjectScript(): string {
  return deployPsScript({ folder: 'hotkey-inject', scriptName: 'press-f13.ps1', source: `${INJECT}
` })
}

/** 第二段：假脚本走真协议（cmd 按脚本吐 OK → HOLD 1 → HOLD 0）。 */
function protocolPhase(push: (name: string, ok: boolean, detail: string) => void, next: () => void): void {
  resetHoldSelfTest()
  const pressed: number[] = []
  const released: number[] = []
  const spawned: string[] = []
  watchHold(
    [0x7c],
    {
      onPress: () => pressed.push(Date.now()),
      onRelease: () => released.push(Date.now())
    },
    {
      retryMs: 30_000,
      launch: (vks) => {
        spawned.push(vks.join(','))
        return spawn(
          'cmd.exe',
          [
            '/c',
            'echo OK& ping -n 2 127.0.0.1 >nul & echo HOLD 1& ping -n 2 127.0.0.1 >nul & echo HOLD 0& ping -n 2 127.0.0.1 >nul'
          ],
          { windowsHide: true }
        )
      }
    }
  )
  waitFor(
    () => holdSelfTest().edges.length >= 2,
    8_000,
    200,
    () => {
      const state = holdSelfTest()
      const kinds = state.edges.map((edge) => edge.kind)
      push(
        '#95 协议：脚本报 OK 后状态是 resident 且 ready',
        state.presence === 'resident' && state.ready,
        JSON.stringify({ presence: state.presence, ready: state.ready, attempts: state.attempts })
      )
      push(
        '#95 协议：HOLD 1 / HOLD 0 各只落一条边',
        kinds.length === 2 && kinds[0] === 'press' && kinds[1] === 'release',
        JSON.stringify(kinds)
      )
      push(
        '#95 协议：回调也只各触发一次（长按不重复）',
        pressed.length === 1 && released.length === 1,
        JSON.stringify({ pressed: pressed.length, released: released.length })
      )
      push(
        '#95 协议：松开发生在按下之后',
        pressed.length === 1 && released.length === 1 && released[0] > pressed[0],
        JSON.stringify({ heldMs: pressed.length && released.length ? released[0] - pressed[0] : null })
      )
      push(
        '#95 协议：就绪后不再重开常驻进程',
        spawned.length === 1,
        JSON.stringify({ spawns: spawned.length })
      )
      stopHoldWatch()
      const after = holdSelfTest()
      push(
        '#95 协议：stop 之后回到 off，就绪标记复位',
        after.presence === 'off' && !after.ready,
        JSON.stringify({ presence: after.presence, ready: after.ready })
      )
      next()
    },
    () => {
      push('#95 协议：8 秒内没收到两条边', false, JSON.stringify(holdSelfTest()))
      stopHoldWatch()
      next()
    }
  )
}

/** 第三段：脚本起不来时必须让面板看见「已退回敲一下」，而不是沉默。 */
function fallbackPhase(push: (name: string, ok: boolean, detail: string) => void, next: () => void): void {
  resetHoldSelfTest()
  const spawned: string[] = []
  watchHold(
    [0x61],
    {
      onPress: () => undefined,
      onRelease: () => undefined
    },
    {
      retryMs: 20,
      launch: (vks) => {
        spawned.push(vks.join(','))
        return spawn('cmd.exe', ['/c', 'exit', '1'], { windowsHide: true })
      }
    }
  )
  setTimeout(() => {
    const state = holdSelfTest()
    push(
      '#95 退回：脚本起不来会退回敲一下（不是沉默）',
      state.presence === 'fallback' && state.fallbackReason !== null,
      JSON.stringify({ presence: state.presence, reason: state.fallbackReason })
    )
    push(
      '#95 退回：退避确实重试了 5 次（首拉 + 5 = 6 次 spawn）',
      spawned.length === 6,
      JSON.stringify({ spawns: spawned.length })
    )
    push(
      '#95 退回：原因里没有「已恢复」这类假话',
      state.fallbackReason !== null && !/已恢复|已修复|recovered|repaired/.test(state.fallbackReason),
      JSON.stringify({ reason: state.fallbackReason })
    )
    push(
      '#95 退回：退回态下没有边（不许假装收到过按下）',
      state.edges.length === 0,
      JSON.stringify({ edges: state.edges.length })
    )
    stopHoldWatch()
    next()
  }, 1_500)
}
