import { dotaDisplayWarning, parseDotaVideoMode } from '@shared/dota-video'
import { dotaDisplayMode } from '../services/gsi-config'
import { finishProbe, probeCases } from './harness'

/**
 * `--dota-display-probe`：读一次 Dota 2 的显示模式。
 *
 * 浮层「被游戏盖住」时先跑这个：独占全屏（`setting.fullscreen = 1`）是 DXGI 独占交换链，
 * 任何窗口都画不上去，改置顶标志没有意义，唯一出路是游戏里改成「全屏窗口」。
 * 读不到不算失败（没装游戏、没启动过、CI 机器都没有），所以断言只锁解析与一致性，
 * 真实模式走 payload —— 它就是这台机器的答案。
 */
export async function runDotaDisplayProbe(): Promise<void> {
  const { cases, push } = probeCases()

  const exclusive = parseDotaVideoMode('"setting.fullscreen"\t\t"1"\n"setting.nowindowborder"\t\t"1"')
  push('fullscreen=1 就是独占全屏', exclusive === 'exclusive', String(exclusive))
  const borderless = parseDotaVideoMode('"setting.fullscreen"\t\t"0"\n"setting.nowindowborder"\t\t"1"')
  push('fullscreen=0 且无边框 = 全屏窗口', borderless === 'borderless', String(borderless))
  const windowed = parseDotaVideoMode('"setting.fullscreen"\t\t"0"\n"setting.nowindowborder"\t\t"0"')
  push('fullscreen=0 且有边框 = 窗口', windowed === 'windowed', String(windowed))
  push('缺设置项不猜', parseDotaVideoMode('"setting.aspectratiomode"\t\t"1"') === null, '')

  const mode = await dotaDisplayMode()
  push('这台机器读得到设置', mode !== null, mode ?? '没读到（没装游戏 / 没启动过）')
  // 读不到时 dotaDisplayWarning 给的是「没读到」那句，不含「独占全屏」——两边必须一致。
  push(
    '模式与警告一致',
    (mode === 'exclusive') === (dotaDisplayWarning(mode)?.includes('独占全屏') ?? false),
    mode ?? 'null'
  )

  finishProbe('DOTA_DISPLAY_PROBE', cases, { mode: mode ?? 'null' })
}
