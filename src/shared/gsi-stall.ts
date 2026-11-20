/**
 * GSI 断流诊断（issue #75）：Dota 停推帧时应用会安静得像是「一切正常」。
 * 这是诊断 + 操作指引，不是自愈——Dota 只在启动时读 gamestate_integration/*.cfg，
 * 运行中的游戏没有任何进程内手段能重载它，所以每一种用户可见的文案都必须说「重启 Dota」。
 */
export interface GsiStallView {
  /**
   * `fresh` = 没有断流可报；`stalled` = 有过一局在打、然后帧停了。
   * 注意 stalled 会跨越「心跳超时后捕获已经停掉」这段时间：告警不能因为
   * 捕获停了就消失，那正是用户最需要看到它的时候。
   */
  state: 'fresh' | 'stalled'
  /** 断流发生时距上一帧的毫秒数；`fresh` 且无帧可算时为 null。 */
  silentMs: number | null
  /** `fresh` 且有值：正常推送时的一句话说明（「N 秒前收到帧」）。 */
  since?: string
  /** 只有 `stalled` 时有：面板显示的告警文案，必须说「重启 Dota」。 */
  warning?: string
  /** 只有 `stalled` 时有：面板「对局正文」那行要挂的动作提示。 */
  action?: 'restart-dota'
}

/** 超过这个时长没有新帧就判断流。与心跳超时同量级：短了会把加载/选人阶段的空档当事故。 */
export const GSI_STALL_AFTER_MS = 90_000

function spokenSilence(silentMs: number): string {
  return silentMs < 60_000 ? `${Math.round(silentMs / 1000)} 秒` : `${Math.round(silentMs / 60_000)} 分钟`
}

/**
 * 断流文案。单独导出是因为它同时出现在两处（诊断行与面板），
 * 分开写迟早会一处改成「已恢复」而另一处还是「重启」——票面明令不许出现前者。
 */
export function gsiStallWarning(silentMs: number): string {
  return `Dota 已经 ${spokenSilence(silentMs)}没推帧了：改过 cfg、或游戏异常退出过。重启 Dota 才会重新连上（GSI 配置只在启动时读一次）`
}

/**
 * 判定断流：只看「应用相信现在有一局正在进行」且「很久没有新帧」。
 * `lastAt === null`（从没收到过帧）不算断流——那是「还没连上」，上手检查里另有说法；
 * `live === false`（不在一局里）更不算，主菜单停推是常态。
 */
export function judgeGsiStall(input: {
  live: boolean
  lastAt: number | null
  now: number
  stallMs?: number
}): GsiStallView {
  const stallMs = input.stallMs ?? GSI_STALL_AFTER_MS
  if (!input.live || input.lastAt === null) return { state: 'fresh', silentMs: null }
  const silentMs = Math.max(0, input.now - input.lastAt)
  if (silentMs >= stallMs) {
    return { state: 'stalled', silentMs, warning: gsiStallWarning(silentMs), action: 'restart-dota' }
  }
  // 正常推送时也把「几秒前收到帧」亮出来：断流之后用户回来看一眼，
  // 就能分辨「刚才还在推」和「从来没推过」，这决定他该重启游戏还是先查配置。
  return { state: 'fresh', silentMs, since: `${spokenSilence(silentMs)}前收到帧` }
}
