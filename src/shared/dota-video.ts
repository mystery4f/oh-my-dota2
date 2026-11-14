/**
 * Dota 2 的显示模式：浮层「被游戏盖住」的唯一根因就在这里。
 *
 * 独占全屏（`setting.fullscreen = 1`）是 DXGI 的独占交换链，任何窗口都画不到它上面——
 * 这不是置顶标志写错了，改 `setAlwaysOnTop` 也没用。能盖住的只有「全屏窗口」（无边框），
 * 它仍是一个普通窗口，置顶浮层就能浮在它上面。
 *
 * 所以本模块只做两件事：把 `video.txt` 读成一个模式值，把模式翻译成一句用户能照做的话。
 * 纯函数，没有文件系统访问——读哪份 video.txt 由 main 侧决定。
 */
export type DotaDisplayMode = 'exclusive' | 'borderless' | 'windowed'

/** 面板上显示的模式名。 */
export const DOTA_DISPLAY_LABEL: Record<DotaDisplayMode, string> = {
  exclusive: '独占全屏',
  borderless: '全屏窗口',
  windowed: '窗口'
}

/**
 * 从 `userdata/<账号>/570/local/cfg/video.txt` 的原文里认模式。
 * 读不出关键项就返回 null（游戏没启动过、文件被删、格式变了），面板按「读不到」处理。
 */
export function parseDotaVideoMode(text: string): DotaDisplayMode | null {
  const fullscreen = /"setting\.fullscreen"\s+"(-?\d+)"/.exec(text)
  if (!fullscreen) return null
  if (fullscreen[1] === '1') return 'exclusive'
  const border = /"setting\.nowindowborder"\s+"(\d+)"/.exec(text)
  return border?.[1] === '1' ? 'borderless' : 'windowed'
}

/**
 * 面板上那句话。只有独占全屏需要警告——其余两种模式下浮层本来就该看得见，
 * 再提示就是噪音；读不到也要说，否则用户会以为这条检查不存在。
 */
export function dotaDisplayWarning(mode: DotaDisplayMode | null): string | null {
  if (mode === 'exclusive') {
    return '独占全屏的游戏画面盖在所有窗口之上，浮层会被挡住；在 Dota 2 里把显示模式改成「全屏窗口」'
  }
  if (mode === null) return '没读到 Dota 2 的显示设置：进一次游戏再回来看（或检查 Steam 安装路径）'
  return null
}
