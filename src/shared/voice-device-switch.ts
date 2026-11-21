/**
 * 声出设备的热切换（#91）。
 *
 * 设置里的 `ttsOutputDevice` 在**起播那一刻**才被读一次，于是「同一句里的第二段」永远用第一段那台设备；
 * 而如果那台设备刚好掉了，渲染层会静默回落到系统默认——听起来还在说话，实际上话进了错的设备。
 *
 * 两条规则写在这个纯缝里，播放器只负责执行：
 * - 切换只发生在**段与段之间**：正在播的那一段不动（截断一段比晚一段更糟）。
 * - 新设备起不来就退回到「上一台真正工作过的设备」，并且必须说一句；静默回退等于让人以为设备没坏。
 */

export interface DeviceSwitchPlan {
  /** 这一段该请求的设备 id（空串 = 系统默认）。 */
  device: string
  /** 与上一段不同 → 真换了。 */
  switched: boolean
  /** 正在播时被推迟到下一段。 */
  deferred: boolean
  /** 需要说出来的一句话；不用换设备时为 null。 */
  line: string | null
}

/**
 * 决定这一段的设备。`playing` 只用来回答「现在能不能换」——播放器在段边界调用它，
 * 这个参数是为了让「播到一半不许换」这条规则可以被探针钉住，而不是靠调用方自觉。
 */
export function planDeviceSwitch(input: {
  active: string
  desired: string
  playing?: boolean
  /** 这一次会话里刚刚没起来的设备：设置还指着它时不要每段再试一遍。 */
  bad?: string
}): DeviceSwitchPlan {
  const active = input.active ?? ''
  const desired = input.desired ?? ''
  const bad = input.bad ?? ''
  if (input.playing === true && desired !== active) {
    return { device: active, switched: false, deferred: true, line: null }
  }
  if (desired === active) return { device: active, switched: false, deferred: false, line: null }
  if (bad !== '' && desired === bad) {
    return { device: active, switched: false, deferred: false, line: '刚换的设备没起来，这一段继续用原来那台' }
  }
  return {
    device: desired,
    switched: true,
    deferred: false,
    line: desired === '' ? '声出回到系统默认设备' : '声出换到新设备，下一段生效'
  }
}

export interface DeviceSettleResult {
  /** 这一段之后，下一次该请求谁。 */
  active: string
  /** 真正起播的设备与请求的不是同一个（渲染层回落了）。 */
  fellBack: boolean
  /** 回落时要说的那句话；没回落就是 null。 */
  line: string | null
}

/**
 * 一段播完之后结算：渲染层回报 `fallback: true` 说明请求的设备用不了，它实际用了 `sinkId`。
 * 这时候**把回落的设备记成新的 active**——下一段继续请求那台坏设备，等于每一段都重演一次失败。
 */
export function settleDeviceAfterPlay(input: {
  requested: string
  fallback: boolean
  sinkId: string
  sinkLabel: string
  hint: string | null
}): DeviceSettleResult {
  if (!input.fallback || input.sinkId === '' ) return { active: input.requested, fellBack: false, line: null }
  const label = input.sinkLabel === '' ? '系统默认设备' : input.sinkLabel
  const asked = input.requested === '' ? '系统默认设备' : input.requested
  const line = input.hint !== null && input.hint !== '' ? input.hint : `「${asked}」用不了，这一段改播到「${label}」`
  return { active: input.sinkId, fellBack: true, line }
}