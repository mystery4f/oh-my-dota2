/**
 * 本局时间线（issue #162）：把播报事件攒成「这一局发生过什么」。
 *
 * 与播报的分工写在两处，别混：播报回答「念不念」，时间线回答「发生过什么」——
 * 所以喂料点必须在总闸判断之前，用户关掉播报也照收；关闸时只是不念、不落日志。
 *
 * 本文件只做纯函数：事件收进来、排好序、标上已办。不念、不落盘、不读时钟。
 */
import type { DotaAnnounceEvent, DotaAnnounceTriggerId } from './dota-announce'

/** 同一秒多条时按这个固定次序排，保证同样输入逐字节同样输出（探针靠它比对）。 */
export const TIMELINE_KIND_ORDER: readonly DotaAnnounceTriggerId[] = [
  'wisdom',
  'rosh',
  'stack',
  'pull'
]

export interface TimelineEntry {
  /** `${kind}@${gameTime}`：可重建、可当「已办」的键；换随机 id 会让重建后的已办错位。 */
  id: string
  kind: DotaAnnounceTriggerId
  /** 触发那一刻的游戏时间（秒）。 */
  gameTime: number
  text: string
  /** 「已办」是界面状态：只存内存、按 matchid 清，不写设置也不落盘。 */
  done: boolean
}

export interface MatchTimelineView {
  /** 本局 id；空串就是「不在对局里」（菜单、训练场、GSI 断了）。 */
  matchid: string
  entries: TimelineEntry[]
  /** 一句给界面直接画的话，不在渲染层拼。 */
  line: string
}

/** 一条事件的键。 */
export function timelineIdOf(event: DotaAnnounceEvent): string {
  return `${event.id}@${event.gameTime}`
}

function kindRank(kind: DotaAnnounceTriggerId): number {
  const at = TIMELINE_KIND_ORDER.indexOf(kind)
  return at < 0 ? TIMELINE_KIND_ORDER.length : at
}

/**
 * 事件 → 时间线条目：按 gameTime 倒序（最近的在上），同龄按固定种类次序再按 id。
 *
 * 排序只在「收进来的事实」上做，不看 done：置办不该让一条往上蹿两格，
 * 否则用户点一下「已办」整屏就重排了。
 */
export function timelineEntriesOf(
  events: readonly DotaAnnounceEvent[],
  done: ReadonlySet<string> = new Set()
): TimelineEntry[] {
  const rows = events.map((event) => ({
    id: timelineIdOf(event),
    kind: event.id,
    gameTime: event.gameTime,
    text: event.text,
    done: done.has(timelineIdOf(event))
  }))
  return rows.sort((a, b) => {
    if (a.gameTime !== b.gameTime) return b.gameTime - a.gameTime
    const rank = kindRank(a.kind) - kindRank(b.kind)
    if (rank !== 0) return rank
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/** 还欠几件（已办的不算）。 */
export function timelinePendingCount(entries: readonly TimelineEntry[]): number {
  return entries.reduce((sum, entry) => (entry.done ? sum : sum + 1), 0)
}

/**
 * 一句给界面的话。三种空态各说各的，绝不用同一句「暂无数据」糊过去：
 * 不在对局里 / 这一局还没事发生 / 都办完了。
 */
export function timelineLine(matchid: string, entries: readonly TimelineEntry[]): string {
  if (matchid === '') return '不在对局里'
  if (entries.length === 0) return '这局还没有值得停一下的事'
  const pending = timelinePendingCount(entries)
  if (pending === 0) return `这局 ${entries.length} 件都办完了`
  return `这局 ${entries.length} 件：还欠 ${pending} 件`
}

/** 视图：matchid + 条目 + 一句话。 */
export function timelineViewOf(input: {
  matchid: string
  events: readonly DotaAnnounceEvent[]
  done?: ReadonlySet<string>
}): MatchTimelineView {
  const entries = timelineEntriesOf(input.events, input.done ?? new Set())
  return { matchid: input.matchid, entries, line: timelineLine(input.matchid, entries) }
}
