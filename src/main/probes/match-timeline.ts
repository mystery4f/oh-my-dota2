/**
 * #162 探针：本局时间线。
 *
 * 票面验收逐条钉住：
 * - 空局（没帧）→ 空数组，`line` 说「不在对局里」；
 * - `matchid` 变 → 整表清空（含「已办」）；
 * - **总闸关着仍然记**，并且关闸期间状态机照走：同一段帧 `total:false` 跑完再 `total:true` 喂一帧，
 *   只出这一帧该出的事件（#162 C1，行为变更，必须钉死）；
 * - 只报看得见的事实：帧里没有 `roshan` 块就不许出肉山条目；
 * - `done` 置位后排序不变，重复置位幂等，不存在的 id 也幂等；
 * - 同样输入逐字节同样输出（广播与界面都靠它）；
 * - 探针全程注入时钟与注入日志，不写 `announce.jsonl`，常驻 `liveState` 与常驻时间线都干净离开。
 */
import { initialAnnounceState, type DotaAnnounceEvent } from '@shared/dota-announce'
import { timelineEntriesOf, timelineIdOf, timelineLine, timelineViewOf } from '@shared/match-timeline'
import { feedAnnouncement, type FeedAnnounceOptions } from '../services/voice/announce'
import {
  markTimelineDone,
  matchTimelineEntriesForProbe,
  matchTimelineView,
  noteTimelineEvents,
  resetMatchTimelineForProbe
} from '../services/voice/match-timeline'
import { resetLiveMatch, noteLiveMatch } from '../services/gsi-match'
import { finishProbe, probeCases } from './harness'

export async function runMatchTimelineProbe(): Promise<void> {
  const { cases, push } = probeCases()
  resetMatchTimelineForProbe()
  resetLiveMatch()

  const noop = (): void => undefined
  function options(extra: Partial<FeedAnnounceOptions>): FeedAnnounceOptions {
    return {
      total: true,
      per: { wisdom: true, rosh: true, stack: true, pull: true },
      speak: noop,
      log: noop,
      ...extra
    }
  }

  // —— 空态：不在对局里，不是「没有数据」 ——
  {
    const view = matchTimelineView(1_000)
    push('空局：条目是空数组', view.entries.length === 0)
    push('空局：一句话说「不在对局里」', view.line === '不在对局里', view.line)
    push('空局：matchid 是空串而不是猜一个', view.matchid === '', view.matchid)
    push('空局：这局还没事发生是另一句话', timelineLine('42', []) === '这局还没有值得停一下的事', timelineLine('42', []))
  }

  // —— 总闸关着也要收；且关闸期间状态机照走（C1 的成对断言） ——
  {
    const state = initialAnnounceState()
    const collected: DotaAnnounceEvent[] = []
    const frame = { gameTime: 420, matchId: '77' }
    const off = feedAnnouncement(frame, state, options({ total: false, timeline: (events) => collected.push(...events) }))
    push('关闸：念出去的数组为空（返回的是「念了什么」）', off.length === 0, JSON.stringify(off))
    push('关闸：时间线照样收到这一帧的事件', collected.length === 1 && collected[0].id === 'wisdom', JSON.stringify(collected))
    push('关闸：状态机也照走（#162 C1）', state.wisdomIndex === 1, String(state.wisdomIndex))

    const later = feedAnnouncement(
      { gameTime: 421, matchId: '77' },
      state,
      options({ total: true, timeline: (events) => collected.push(...events) })
    )
    push('开闸后只出这一帧该出的事，不补报旧窗口', later.length === 0, JSON.stringify(later))
  }

  // —— 关闸期间收到的喂给常驻时间线：可见、且与念不念无关 ——
  {
    const state = initialAnnounceState()
    const feed = (frame: { gameTime: number; matchId: string }, total: boolean): void =>
      void feedAnnouncement(
        frame,
        state,
        options({ total, timeline: (events) => noteTimelineEvents(frame.matchId, events) })
      )
    noteLiveMatch('9001', 1_240_000)
    feed({ gameTime: 420, matchId: '9001' }, false)
    feed({ gameTime: 900, matchId: '9001' }, false)
    const view = matchTimelineView(1_240_000)
    push('关闸也收：常驻时间线数得出两条', view.entries.length === 2, JSON.stringify(view.entries.map((e) => e.id)))
    push('关闸也收：倒序（最近的在最上）', view.entries[0].gameTime === 900, JSON.stringify(view.entries.map((e) => e.gameTime)))
    push('关闸也收：一句话带还欠几件', view.line === '这局 2 件：还欠 2 件', view.line)
  }

  // —— 已办：置位不改排序、重复幂等、不存在的 id 幂等 ——
  {
    const before = matchTimelineEntriesForProbe().map((entry) => entry.id)
    const view = markTimelineDone(before[1], true, 1_240_000)
    push('置办后排序不变', JSON.stringify(view.entries.map((e) => e.id)) === JSON.stringify(before), JSON.stringify(view.entries.map((e) => e.id)))
    push('置办后那一条标上已办', view.entries.find((e) => e.id === before[1])?.done === true)
    push('置办后一句话减一件', view.line === '这局 2 件：还欠 1 件', view.line)
    const twice = markTimelineDone(before[1], true, 1_240_000)
    push('重复置办幂等', twice.entries.filter((e) => e.done).length === 1, JSON.stringify(twice.entries.map((e) => e.done)))
    const ghost = markTimelineDone('不存在的@1', true, 1_240_000)
    push('不存在的 id 置办幂等（不抛、不改）', ghost.entries.filter((e) => e.done).length === 1, JSON.stringify(ghost.entries.map((e) => e.done)))
    const cleared = markTimelineDone(before[1], false, 1_240_000)
    push('取消置办回到未办', cleared.line === '这局 2 件：还欠 2 件', cleared.line)
    markTimelineDone(before[0], true, 1_240_000)
    const allDone = markTimelineDone(before[1], true, 1_240_000)
    push('全办完是第三句话', allDone.line === '这局 2 件都办完了', allDone.line)
  }

  // —— 换局：整表清空，已办跟着清 ——
  {
    noteLiveMatch('9002', 1_241_000)
    noteTimelineEvents('9002', [{ id: 'stack', gameTime: 53, text: '堆野窗口到了' }])
    const view = matchTimelineView(1_241_000)
    push('换局后只剩新局的事件', view.entries.length === 1 && view.entries[0].id === 'stack@53', JSON.stringify(view.entries.map((e) => e.id)))
    push('换局后已办也清空', view.entries.every((entry) => !entry.done))
  }

  // —— 只报看得见的事实：帧里没有 roshan 块就没有肉山条目 ——
  {
    const state = initialAnnounceState()
    const events: DotaAnnounceEvent[] = []
    void feedAnnouncement({ gameTime: 1200, matchId: '9002' }, state, options({ timeline: (got) => events.push(...got) }))
    push('没有 roshan 块就不出肉山条目', events.every((event) => event.id !== 'rosh'), JSON.stringify(events.map((event) => event.id)))
    const withDead = initialAnnounceState()
    const dead: DotaAnnounceEvent[] = []
    void feedAnnouncement(
      { gameTime: 1200, matchId: '9002', roshan: { state: 'dead', death_time: 600 } },
      withDead,
      options({ timeline: (got) => dead.push(...got) })
    )
    push('roshan 块说 dead 且过了八分钟才出肉山窗口', dead.some((event) => event.id === 'rosh'), JSON.stringify(dead.map((event) => event.id)))
  }

  // —— 逐字节确定：同样输入同样输出 ——
  {
    const input: DotaAnnounceEvent[] = [
      { id: 'pull', gameTime: 300, text: '拉野窗口到了' },
      { id: 'wisdom', gameTime: 300, text: '智慧符刷新了' },
      { id: 'stack', gameTime: 300, text: '堆野窗口到了' }
    ]
    const once = JSON.stringify(timelineEntriesOf(input))
    const twice = JSON.stringify(timelineEntriesOf(input))
    push('同样输入逐字节同样输出', once === twice, once)
    push('同一秒按固定种类次序排（智慧符在堆野前）', timelineEntriesOf(input).map((e) => e.kind).join(',') === 'wisdom,stack,pull', timelineEntriesOf(input).map((e) => e.kind).join(','))
    push('条目 id 是 kind@gameTime', timelineIdOf(input[0]) === 'pull@300', timelineIdOf(input[0]))
  }

  // —— 不在对局里：视图空，不让旧局数据冒充当前局（广播侧同一条判断） ——
  {
    const stale = matchTimelineView(9_999_999)
    push('帧停了就回空表（旧局不当当前局）', stale.matchid === '' && stale.entries.length === 0, JSON.stringify(stale))
    push('断流后的视图同样是「不在对局里」', stale.line === '不在对局里', stale.line)
  }

  // —— 脏输入：空事件、空 matchid 都不该进表 ——
  {
    resetMatchTimelineForProbe()
    noteTimelineEvents('', [{ id: 'wisdom', gameTime: 420, text: '智慧符刷新了' }])
    push('matchid 为空（菜单/训练场）不收事件', matchTimelineEntriesForProbe().length === 0)
    noteTimelineEvents('0', [{ id: 'wisdom', gameTime: 420, text: '智慧符刷新了' }])
    push('matchid 为 "0"（主菜单/训练场/人机）也不收', matchTimelineEntriesForProbe().length === 0)
    noteTimelineEvents('12', [{ id: 'wisdom', gameTime: 420, text: '智慧符刷新了' }])
    push('位数太短的不是对局号，同样不收', matchTimelineEntriesForProbe().length === 0)
    noteTimelineEvents('9061502086', [{ id: 'wisdom', gameTime: 420, text: '智慧符刷新了' }])
    push('十几位真对局号才收', matchTimelineEntriesForProbe().length === 1)
    noteTimelineEvents('9003', [])
    push('空事件数组既不建局也不清掉已有的那条', matchTimelineEntriesForProbe().length === 1)
    const view = timelineViewOf({ matchid: '', events: [] })
    push('空视图不带任何条目', view.entries.length === 0 && view.line === '不在对局里', view.line)
  }

  // —— 干净离开：常驻时间线复位，不留跨探针脏数据 ——
  {
    resetMatchTimelineForProbe()
    resetLiveMatch()
    push('探针离开时常驻时间线是干净的', matchTimelineEntriesForProbe().length === 0)
    push('探针离开时视图回到空态', matchTimelineView(1).matchid === '' && matchTimelineView(1).entries.length === 0)
  }

  finishProbe('MATCH_TIMELINE_PROBE', cases)
}
