/**
 * 比赛目标与计时播报（issue #123）纯状态机。
 *
 * 规则铁律：只信「静态知识表 + 游戏时钟」，不注入、不 OCR、不猜。
 * 每条触发只能基于帧里看得见的事实：game_time、matchid、roshan 块的生死时间。
 * 因此 Aegis 到期（需要拾取事件，GSI 不给）和买活就绪（需要按英雄查经济，GSI 不给）
 * 不在触发表里——给不出事实的触发不做，宁可少报不瞎报。
 *
 * 本文件只做「帧 → 该不该报」的判定，一句都不负责念：念由主进程 feed 层决定。
 */
export type DotaAnnounceTriggerId = 'wisdom' | 'rosh' | 'stack' | 'pull'

export interface DotaAnnounceTriggers {
  wisdom: boolean
  rosh: boolean
  stack: boolean
  pull: boolean
}

export interface DotaAnnounceFrame {
  /** Dota 内时钟（秒）；没有就 null，什么都不触发。 */
  gameTime: number | null
  /** 当前局 id：换局就把跨分钟/跨局的触发记忆清掉，不带到下一局。 */
  matchId: string | null
  /** cfg 里的 roshan 块（探针/真帧都可能是 undefined）。 */
  roshan?: { state?: string; death_time?: number; respawn_time?: number } | null
}

export interface DotaAnnounceEvent {
  id: DotaAnnounceTriggerId
  /** 触发那一刻的游戏时间（秒）。 */
  gameTime: number
  /** 念什么：静态文案，不含任何来自帧以外的数字。 */
  text: string
}

/** 智慧符：开局 7:00 刷新，之后每 7 分钟一次（7:00/14:00/21:00…）。 */
export const WISDOM_FIRST_SEC = 7 * 60
export const WISDOM_EVERY_SEC = 7 * 60
/** 堆野窗口：每分钟 :53 到 :55。 */
export const STACK_WINDOW_SEC = [53, 55] as const
/** 拉野窗口：每分钟 :15 和 :45（起始拉/拉两波都在这两个刻）。 */
export const PULL_SEC = [15, 45] as const
/** 肉山复活窗口：击杀后 8–11 分钟（480–660 秒）。只报窗口起点，一句。 */
export const ROSH_WINDOW_MIN_SEC = 8 * 60
export const ROSH_WINDOW_MAX_SEC = 11 * 60

export const DEFAULT_ANNOUNCE_TRIGGERS: DotaAnnounceTriggers = {
  wisdom: true,
  rosh: true,
  stack: true,
  pull: true
}

export interface DotaAnnounceState {
  /** 已触发的智慧符序号（-1 = 还没到第一个）。 */
  wisdomIndex: number
  /** 已报过堆野的分钟（-1 = 本局还没报过）。 */
  stackMinute: number
  /** 已报过拉野的分钟（-1 = 本局还没报过）；:15 与 :45 各算一次，所以存「分钟×2+半点」。 */
  pullSlot: number
  /** 肉山状态所归属的局。 */
  roshMatchId: string | null
  /** 肉山死掉的时间（秒）；不知道就是 null。 */
  roshDeathAt: number | null
  /** 本局是否已报过肉山窗口。 */
  roshFired: boolean
}

export function initialAnnounceState(): DotaAnnounceState {
  return {
    wisdomIndex: -1,
    stackMinute: -1,
    pullSlot: -1,
    roshMatchId: null,
    roshDeathAt: null,
    roshFired: false
  }
}

function wisdomText(): string {
  return '智慧符刷新了'
}
function roshText(): string {
  return '肉山复活窗口，大概八到十一分钟后复活'
}
function stackText(): string {
  return '堆野窗口到了'
}
function pullText(): string {
  return '拉野窗口到了'
}

/**
 * 一帧 → 该报的事。纯函数：同样状态同样帧，结果逐字节一致（探针靠它断「恰好一次」）。
 * 触发只发生在边界跨越/分钟切换时，不存在「同一事件报两遍」：
 * 智慧符按序号严格递增；堆野/拉野每分钟各报一次；肉山每局每死一次只报一次。
 * 窗口内的每一帧都会调到这个函数；返回的事件是这帧带来的全部新触发，调用方负责念。
 *
 * Aegis 到期与买活就绪不做，原因见文件头：帧里没有拾取/经济事实，做出来就是编。
 */
export function stepAnnounces(state: DotaAnnounceState, frame: DotaAnnounceFrame): DotaAnnounceEvent[] {
  if (frame.gameTime === null || !Number.isFinite(frame.gameTime) || frame.gameTime < 0) return []
  const events: DotaAnnounceEvent[] = []
  const gameTime = Math.floor(frame.gameTime)

  // 智慧符：开局 7:00 起每 7 分钟一次。序号法而不是「距上次 > 420」，
  // 因为 GSI 帧稀疏时可能整段跳过去，靠差值会漏报。
  const wisdomIndex =
    gameTime < WISDOM_FIRST_SEC
      ? -1
      : 1 + Math.floor((gameTime - WISDOM_FIRST_SEC) / WISDOM_EVERY_SEC)
  if (wisdomIndex > state.wisdomIndex) {
    state.wisdomIndex = wisdomIndex
    events.push({ id: 'wisdom', gameTime, text: wisdomText() })
  }

  const minute = Math.floor(gameTime / 60)
  const second = gameTime % 60
  const stackOn = second >= STACK_WINDOW_SEC[0] && second <= STACK_WINDOW_SEC[1]
  if (stackOn && minute !== state.stackMinute) {
    state.stackMinute = minute
    events.push({ id: 'stack', gameTime, text: stackText() })
  }
  // 拉野一分钟两个刻（:15 与 :45），所以记忆要存「分钟 × 2 + 前半/后半」：
  // 只按分钟记会把 :45 当重复吞掉（探针第一版就是被这条钉出来的）。
  const pullSlot = second === PULL_SEC[0] ? minute * 2 : second === PULL_SEC[1] ? minute * 2 + 1 : null
  if (pullSlot !== null && pullSlot !== state.pullSlot) {
    state.pullSlot = pullSlot
    events.push({ id: 'pull', gameTime, text: pullText() })
  }

  // 肉山：roshan 块给 state=dead + death_time 才认（没有事实就不报）。
  // 换局清记忆；块里变回 alive 也清（这一死算过去了）。
  const rosh = frame.roshan
  if (frame.matchId !== state.roshMatchId) {
    state.roshMatchId = frame.matchId ?? null
    state.roshDeathAt = null
    state.roshFired = false
  }
  if (rosh?.state === 'dead' && typeof rosh.death_time === 'number' && rosh.death_time > 0) {
    if (!state.roshFired && state.roshDeathAt === null) state.roshDeathAt = rosh.death_time
    if (!state.roshFired && state.roshDeathAt !== null && gameTime >= state.roshDeathAt + ROSH_WINDOW_MIN_SEC) {
      state.roshFired = true
      events.push({ id: 'rosh', gameTime, text: roshText() })
    }
  } else if (rosh?.state === 'alive') {
    state.roshDeathAt = null
    state.roshFired = false
  }

  return events
}

/** 探针/测试用的「一口气推一串帧」助手：返回每一帧各自产生的触发。 */
export function runAnnounceFrames(
  state: DotaAnnounceState,
  frames: DotaAnnounceFrame[]
): DotaAnnounceEvent[][] {
  return frames.map((frame) => stepAnnounces(state, frame))
}