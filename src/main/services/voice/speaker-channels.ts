/**
 * 驾驶室要的「每人一条频道」的账本（#160）。
 *
 * 只做三件事：收 GSI 的聊天事件、按当前对局算关系、换局清空。真对局拿不到别人名字，
 * 所以这里**没有**名字缓存，只有座位——猜名字这条路从一开始就不开。
 */

import { buildSpeakerChannels, normalizeSlot, type SpeakerChannels } from '@shared/speaker-channel'

/** 一局留多少句。驾驶室只看最近这些；多留只会把跨局串人的窗口变长。 */
const EVENTS_KEEP = 200

interface LedgerEvent {
  slot: number
  at: number
  gameTime: number | null
  channel: number | null
  text: string
}

let matchid: string | null = null
let selfSlot: number | null = null
let selfTeam = ''
let ledger: LedgerEvent[] = []
let heroes = new Map<number, string>()
let teams = new Map<number, string>()

/** 换局（或第一次来帧）就整本清掉：留着上一局的座位就是跨局串人。 */
function adoptMatch(next: string | null): void {
  if (next === matchid) return
  matchid = next
  ledger = []
  heroes = new Map()
  teams = new Map()
}

/** 每帧更新一次「我是谁、我在哪边」，不产生频道。 */
export function noteSpeakerSelf(input: { matchid: string | null; slot: number | null; team: string }): void {
  adoptMatch(input.matchid)
  selfSlot = input.slot === null ? null : normalizeSlot(input.slot)
  if (input.team) selfTeam = input.team.toLowerCase()
}

/** 已确认的座位信息（来自 allplayers 或本机 player 块）：拿到才记，拿不到就不记。 */
export function noteSpeakerSlot(slot: number, info: { hero?: string; team?: string }): void {
  const seat = normalizeSlot(slot)
  if (info.hero) heroes.set(seat, info.hero)
  if (info.team) teams.set(seat, info.team.toLowerCase())
}

/** 收一条聊天。空文本不进账本——界面上的空行比没有行更糟。 */
export function noteSpeakerEvent(input: {
  matchid: string | null
  slot: number | undefined
  at: number
  gameTime: number | null
  channel: number | null
  text: string
}): void {
  adoptMatch(input.matchid)
  if (input.slot === undefined || !input.text.trim()) return
  ledger.push({
    slot: input.slot,
    at: input.at,
    gameTime: input.gameTime,
    channel: input.channel,
    text: input.text.trim()
  })
  if (ledger.length > EVENTS_KEEP) ledger = ledger.slice(ledger.length - EVENTS_KEEP)
}

/** 当前对局的频道视图。没事件就是空数组 + 一句话，不伪造灰频道。 */
export function speakerChannels(): SpeakerChannels {
  return buildSpeakerChannels({
    matchid,
    mySlot: selfSlot,
    myTeam: selfTeam,
    teamOf: (slot) => teams.get(normalizeSlot(slot)) ?? '',
    heroOf: (slot) => heroes.get(normalizeSlot(slot)) ?? '',
    events: ledger
  })
}

/** 探针用：把账本清成刚启动的样子。 */
export function resetSpeakerChannels(): void {
  matchid = null
  selfSlot = null
  selfTeam = ''
  ledger = []
  heroes = new Map()
  teams = new Map()
}
