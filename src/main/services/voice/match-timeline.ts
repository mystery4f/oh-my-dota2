/**
 * 本局时间线的常驻状态（issue #162）。
 *
 * 为什么喂料挂在这里而不是 `feedAnnouncement` 的调用方：时间线回答「这一局发生过什么」，
 * 与「念不念」无关。播报总闸关着时事件照样要进来，否则用户一关播报，驾驶室整屏空白
 * —— 那是最典型的「看着像没数据，其实是自己把数据断了」。
 *
 * 只存内存：换局（matchid 变了）整表清空，「已办」跟着一起清；重启后消失是可接受的，
 * 落盘就要处理跨局脏数据。`announce.jsonl` 一个字节都不动（它是排查凭据，且只记播过的）。
 */
import { broadcastToWindows } from '../../windows/broadcast'
import { IPC } from '@shared/ipc'
import {
  timelineViewOf,
  type MatchTimelineView,
  type TimelineEntry
} from '@shared/match-timeline'
import type { DotaAnnounceEvent } from '@shared/dota-announce'
import { liveMatchId } from '../gsi-match'
import { isRealMatchId } from '@shared/match-id'

/** 本局已经发生过的事件（按到达顺序攒，排序在纯缝里做）。 */
let events: DotaAnnounceEvent[] = []
/** 事件属于哪一局；空串 = 还没进过任何一局。 */
let matchid = ''
/** 「已办」是本局内的界面状态，只在本局有效。 */
const done = new Set<string>()
const watchers = new Set<() => void>()

function notify(): void {
  for (const listener of watchers) listener()
}

/**
 * 一帧带来的全部事件。菜单/训练场（matchid `"0"`）、空 matchid、GSI 断流都不记：
 * 训练场不是对局，记进来就是把练习当成比赛。
 */
export function noteTimelineEvents(
  matchId: string | null | undefined,
  incoming: readonly DotaAnnounceEvent[]
): void {
  if (incoming.length === 0) return
  if (!isRealMatchId(matchId)) return
  if (matchid !== matchId) {
    matchid = matchId
    events = []
    done.clear()
  }
  events.push(...incoming)
  notify()
}

/** 现取视图：`liveMatchId()` 断了就按「不在对局里」回空表（表不清，连回来还看得见）。 */
export function matchTimelineView(now: number = Date.now()): MatchTimelineView {
  const live = liveMatchId(now)
  if (live === null || live !== matchid) return timelineViewOf({ matchid: '', events: [] })
  return timelineViewOf({ matchid, events, done })
}

/** 置位/取消「已办」。不存在的 id 幂等：什么都不改，照样回最新视图。 */
export function markTimelineDone(id: string, flag: boolean, now: number = Date.now()): MatchTimelineView {
  const exists = events.some((event) => `${event.id}@${event.gameTime}` === id)
  if (exists) {
    if (flag) done.add(id)
    else done.delete(id)
    notify()
  }
  return matchTimelineView(now)
}

export function onMatchTimelineChange(listener: () => void): () => void {
  watchers.add(listener)
  return () => {
    watchers.delete(listener)
  }
}

/** 广播用的包装：不在对局里就不推（避免旧局数据被当成当前局画出来）。 */
export function broadcastMatchTimeline(): void {
  const view = matchTimelineView()
  if (view.matchid === '') return
  broadcastToWindows(IPC.MATCH_TIMELINE_STATE, view)
}

/** 仅供探针：清回「还没进过任何一局」。 */
export function resetMatchTimelineForProbe(): void {
  events = []
  matchid = ''
  done.clear()
  watchers.clear()
}

/** 仅供探针：直接读条目，绕过 liveMatchId 的 TTL。 */
export function matchTimelineEntriesForProbe(): TimelineEntry[] {
  return timelineViewOf({ matchid, events, done }).entries
}
