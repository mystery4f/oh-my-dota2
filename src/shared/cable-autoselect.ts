/**
 * 虚拟声卡「自动选中」的唯一判定（#183）。
 *
 * 起因：#90 当初写成「输出不等于 CABLE 就写 CABLE」，注释却说「用户手动选过别的设备就不碰」——
 * 代码做的正好相反：用户有意把输出留成扬声器（不想让队友听见合成音），每次进对讲页都会被改回
 * CABLE。这是**界面覆盖用户决定**，而且安静：没有日志、没有提示。
 *
 * 现在的规则只有一句：**只有在用户还没表过态（输出为空）时才自动选一次**。
 * 已有任何值（含扬声器）就一个字都不写；要找 CABLE 的用户走「用这个设备」按钮
 * （`judgeCableGap()` 的 `select-device` 动作），那是用户的动作，不是页面的。
 *
 * 判定放在这里而不是页面里，是为了让 `check:pure` 能钉住「已有值 → 零次写」这一条：
 * 这类覆盖型 bug 的表现是「改了一次，下次又变」，光读页面代码看不出来。
 */

/** 页面需要知道的三件事：用户表过态没有、端点拿到了没有、检测本身成不成。 */
export interface CableAutoSelectInput {
  /** 当前 `settings.ttsOutputDevice`；空串 = 用户还没表过态 */
  chosen: string
  /** 渲染层清单里的 CABLE 播放端 deviceId；null = 清单里还没有它 */
  cableId: string | null
  /** `voiceOutCable()` 的 error；null = 检测跑成了 */
  error: string | null
  /** 驱动装没装 */
  installed: boolean
  /** 驱动在、端点还没出现（刚装完要重启） */
  driverOnly: boolean
}

/** 不写的原因，写进日志里才有据可查；`auto` 是唯一会写的情形。 */
export type CableAutoSelectReason = 'auto' | 'already-chosen' | 'not-installed' | 'no-endpoint'

export interface CableAutoSelect {
  write: boolean
  from: string
  to: string
  reason: CableAutoSelectReason
}

/**
 * 决定这一拍要不要自动选中。
 * 顺序是「先看用户表过态没有」——一个已经选好扬声器的人，不管驱动怎么变都不该被动到。
 */
export function planCableAutoSelect(input: CableAutoSelectInput): CableAutoSelect {
  if (input.chosen !== '') return { write: false, from: input.chosen, to: input.chosen, reason: 'already-chosen' }
  if (input.error !== null || !input.installed) return { write: false, from: '', to: '', reason: 'not-installed' }
  if (input.driverOnly || input.cableId === null) return { write: false, from: '', to: '', reason: 'no-endpoint' }
  return { write: true, from: '', to: input.cableId, reason: 'auto' }
}
