/**
 * 浮层「为什么没有字」的提示。
 *
 * 浮层平时只有一行小字，正常时有话就上屏；一旦链路断了，它必须替用户回答
 * 「是没进对局 / 停了 / 还是引擎报错」——否则用户只能去翻日志。
 * 纯函数：输入来自 CaptureStatus 与 GSI 状态，探针直接喂对象断言。
 */

export interface HintInput {
  running: boolean
  /** GSI 是否判定当前在局内。 */
  gsiLive: boolean
  lastError: string | null
  /**
   * 「显示/隐藏浮层」当前绑的键（给人看的写法）。提示里点名它，用户才知道按什么恢复；
   * 不传或传空串 = 那个动作没绑键，提示只能说明这一点，不能假装有个键。
   */
  toggleKey?: string
}

export function captureHint(input: HintInput): string | null {
  if (input.lastError) return `捕获出错：${input.lastError}`
  if (!input.running) {
    const key = input.toggleKey ?? ''
    return key ? `捕获已暂停 · ${key} 恢复` : '捕获已暂停 · 「显示/隐藏浮层」没绑键'
  }
  if (!input.gsiLive) return '等待进入对局（GSI 暂无对局）'
  return null
}
