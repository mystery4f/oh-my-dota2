import type { GsiEvent, GsiPayload } from './gsi'

/**
 * GSI 帧的「体检报告」：把 Dota 真实推了什么压成可判断的几行。
 *
 * 为什么要单独一层：`--gsi-dump` 只会把字段路径列出来，回答不了「这局是训练场
 * 还是真对局」「allplayers 到底给不给」「events 里除了聊天还有什么」。
 * 这三问决定后续做哪些功能，必须能离线复算，所以逻辑放在这里、探针只负责喂数据。
 */

export interface PathInfo {
  type: string
  hits: number
  sample: unknown
}

export interface EventKindInfo {
  type: string
  count: number
  /** 最多留三条，够看出字段形状，不会把报告撑爆。 */
  samples: unknown[]
}

export interface DumpSummary {
  frames: number
  /** cfg 里开过的 data 块，哪些真的出现过。Dota 只在有内容时推对应块。 */
  blocks: Record<string, number>
  events: EventKindInfo[]
  /** matchid 全是 0 / 缺失 → 不是真对局，可能是训练场、人机或主菜单。 */
  realMatch: boolean
  matchIds: string[]
  /** allplayers 出现帧数：不是真对局时它通常根本不推。 */
  allplayersFrames: number
  /** 一句人话结论，直接进日志。 */
  verdict: string
}


export function typeOf(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  return typeof value
}

/** 摊平成一串 `map.clock_time` 这样的路径，顺带记住类型和示例值。 */
export function flatten(value: unknown, prefix: string, into: Map<string, PathInfo>): void {
  if (value === null || typeof value !== 'object') {
    const current = into.get(prefix)
    if (current) current.hits += 1
    else into.set(prefix, { type: typeOf(value), hits: 1, sample: value })
    return
  }
  if (Array.isArray(value)) {
    const current = into.get(prefix)
    if (current) current.hits += 1
    else into.set(prefix, { type: 'array', hits: 1, sample: value.slice(0, 3) })
    for (const item of value) {
      if (item !== null && typeof item === 'object') flatten(item, prefix + '[]', into)
    }
    return
  }
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    flatten(child, prefix.length > 0 ? prefix + '.' + key : key, into)
  }
}

/**
 * 事件按 `event_type` 归类。Dota 未知的类型也照收——正因为不知道有什么，
 * 才要把它们一个不落地记下来，之后决定哪类值得做成功能。
 */
export function collectEventKinds(
  events: GsiEvent[] | undefined,
  into: Map<string, EventKindInfo>
): void {
  if (!events) return
  for (const event of events) {
    const type = typeof event.event_type === 'string' ? event.event_type : '(missing)'
    const current = into.get(type)
    if (current) {
      current.count += 1
      if (current.samples.length < 3) current.samples.push(event)
    } else {
      into.set(type, { type, count: 1, samples: [event] })
    }
  }
}

/** 单帧记账：块出现率 + 事件直方图 + matchid 取样。dump 探针逐帧调用。 */
export interface DumpTally {
  frames: number
  blocks: Record<string, number>
  events: Map<string, EventKindInfo>
  matchIds: Set<string>
  allplayersFrames: number
}

export function createTally(): DumpTally {
  return {
    frames: 0,
    blocks: {},
    events: new Map<string, EventKindInfo>(),
    matchIds: new Set<string>(),
    allplayersFrames: 0
  }
}

export function tallyFrame(tally: DumpTally, payload: GsiPayload): void {
  tally.frames += 1
  // 顶层对象/数组一律按块计数：只数白名单会漏记没见过的块，实验就白做。
  for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
    if (value !== null && typeof value === 'object') {
      tally.blocks[key] = (tally.blocks[key] ?? 0) + 1
    }
  }
  const matchId = payload.map?.matchid
  if (typeof matchId === 'string' && matchId.length > 0) tally.matchIds.add(matchId)
  if (payload.allplayers && Object.keys(payload.allplayers).length > 0) tally.allplayersFrames += 1
  collectEventKinds(payload.events, tally.events)
}

function isRealMatchId(matchId: string): boolean {
  // 训练场/人机/主菜单都给 "0"；真对局是十几位数字。
  return matchId.length > 3 && /^\d+$/.test(matchId) && matchId !== '0'
}

export function summarize(tally: DumpTally): DumpSummary {
  const matchIds = [...tally.matchIds]
  const realMatch = matchIds.some(isRealMatchId)
  const events = [...tally.events.values()].sort((a, b) => b.count - a.count)
  const verdictParts: string[] = []
  verdictParts.push(
    realMatch ? `真对局（matchid ${matchIds.filter(isRealMatchId).slice(0, 2).join(', ')}）` : '不是真对局（matchid 为 0 或缺失）'
  )
  verdictParts.push(
    tally.allplayersFrames > 0
      ? `allplayers 有数据（${tally.allplayersFrames}/${tally.frames} 帧）`
      : 'allplayers 一帧都没有'
  )
  verdictParts.push(
    events.length > 0
      ? `事件类型 ${events.map((item) => `${item.type}×${item.count}`).join('、')}`
      : '没有收到任何事件'
  )
  return {
    frames: tally.frames,
    blocks: tally.blocks,
    events,
    realMatch,
    matchIds,
    allplayersFrames: tally.allplayersFrames,
    verdict: verdictParts.join(' · ')
  }
}

/** 从已落盘的 gsi-frames.json 里还原一份结论（判读不必再去听端口）。 */
export interface StoredDump {
  frames?: number
  blocks?: Record<string, number>
  events?: EventKindInfo[]
  matchIds?: string[]
  allplayersFrames?: number
}

export function summarizeStored(dump: StoredDump): DumpSummary {
  const tally = createTally()
  tally.frames = dump.frames ?? 0
  tally.blocks = dump.blocks ?? {}
  tally.events = new Map((dump.events ?? []).map((item) => [item.type, item]))
  tally.matchIds = new Set(dump.matchIds ?? [])
  tally.allplayersFrames = dump.allplayersFrames ?? 0
  return summarize(tally)
}
