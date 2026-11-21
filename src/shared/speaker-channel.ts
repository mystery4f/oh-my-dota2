/**
 * 驾驶室（cockpit）要的那份数据：每个说话人一条「频道」。
 *
 * 这份缝存在的理由是三条真话：
 *
 * 1. 真对局拿不到别人的名字。`src/main/services/gsi-config.ts` 早期用真帧量过（match 9061130332
 *    跑了 3499 帧、match 9061444883 跑了 156 帧），`allplayers` 一次都没推 —— Dota 只在对局中
 *    给本机 `player`/`hero`，全员数据只在观战/录像里到。所以标签一律按座位算：
 *    `我` / `队友 2` / `对手 3`，**绝不**用历史缓存或 OCR 猜名字。猜错人比空着更糟，
 *    这和 `speak-mute.ts` 里「缺身份不构成静音理由」是同一条原则。
 * 2. 没聊天就是没频道。界面写「这局还没人说话」，不许显示十个灰频道冒充数据。
 * 3. 换局必须清空。`matchid` 变了还留着上一局的座位，就是跨局串人。
 */

/** 说话人和我的关系。`unknown` 是独立状态：认不出自己座位时不许猜成队友或对手。 */
export type SpeakerRelation = 'self' | 'teammate' | 'opponent' | 'unknown'

export interface SpeakerEvent {
  /** 本机时间戳（毫秒），用于「最近一句」的排序与显示。 */
  at: number
  /** 对局时间（秒），来自 GSI 的 `game_time`；没有就 null。 */
  gameTime: number | null
  /** 11 = 所有人，12 = 队伍；其它值原样保留。 */
  channel: number | null
  text: string
}

export interface SpeakerChannel {
  /** 归一化后的座位：天辉 0–4、夜魇 5–9（GSI 的 128+ 写法在这里已经折回 0–9）。 */
  slot: number
  /** 界面标签：`我` / `队友 2` / `对手 3` / `认不出`。 */
  label: string
  relation: SpeakerRelation
  /** 已确认的英雄短名，不知道就是空串——不拿别局缓存填。 */
  hero: string
  /** 说了几句。 */
  spoken: number
  /** 最近一句（含在 `events` 里，这里只是省一次查找）。 */
  lastAt: number
  lastText: string
  events: SpeakerEvent[]
}

export interface SpeakerChannels {
  /** 这组频道属于哪一局；没有帧就是 null。 */
  matchid: string | null
  channels: SpeakerChannel[]
  /** 界面要显示的那一句话（空态、认不出、正常三种）。 */
  line: string
  /** 自己座位；认不出时 null，此时所有频道都是 `relation: 'unknown'`。 */
  selfSlot: number | null
}

/** 座位归一：GSI 有 `0–4 / 128–132` 两种写法，折回 0–9。 */
export function normalizeSlot(slot: number): number {
  return ((slot % 128) + 128) % 128
}

/** 座位 → 关系。`mySlot` 为 null（还没拿到 / 认不出）时一律 `unknown`。 */
export function judgeSpeakerRelation(slot: number, mySlot: number | null, myTeam: string, teamOf: (slot: number) => string): SpeakerRelation {
  if (mySlot === null) return 'unknown'
  const seat = normalizeSlot(slot)
  if (seat === normalizeSlot(mySlot)) return 'self'
  const team = teamOf(slot)
  if (team && myTeam) return team === myTeam ? 'teammate' : 'opponent'
  // 阵营没拿到：同一个 0–4 / 5–9 分区只能说明「和我同半边」，说不清是哪一边，不猜。
  return 'unknown'
}

/** 座位 → 标签。队友 2 = 我方第 2 个说话的人（按座位序），对手同理。 */
export function speakerLabel(relation: SpeakerRelation, seat: number): string {
  if (relation === 'self') return '我'
  if (relation === 'unknown') return '认不出'
  return `${relation === 'teammate' ? '队友' : '对手'} ${ordinalOf(seat)}`
}

/**
 * 在该半边内的序号（1–5）：天辉 0–4、夜魇 5–9，取座位对 5 的余数即可。
 * 只用于标签，**不参与任何身份判断**——认人靠座位与阵营，从不靠序号。
 */
function ordinalOf(seat: number): number {
  return (seat % 5) + 1
}

export interface BuildChannelsInput {
  matchid: string | null
  mySlot: number | null
  myTeam: string
  teamOf: (slot: number) => string
  heroOf: (slot: number) => string
  events: readonly { slot: number; at: number; gameTime: number | null; channel: number | null; text: string }[]
}

/**
 * 组装频道。排序：我 → 队友 → 对手 → 认不出，同关系按座位升序 —— 界面每帧重排就没法看，
 * 顺序必须是确定的。
 */
export function buildSpeakerChannels(input: BuildChannelsInput): SpeakerChannels {
  const bySlot = new Map<number, SpeakerChannel>()
  for (const event of input.events) {
    const seat = normalizeSlot(event.slot)
    const relation = judgeSpeakerRelation(event.slot, input.mySlot, input.myTeam, input.teamOf)
    const existing = bySlot.get(seat)
    const item: SpeakerEvent = {
      at: event.at,
      gameTime: event.gameTime,
      channel: event.channel,
      text: event.text
    }
    if (existing === undefined) {
      bySlot.set(seat, {
        slot: seat,
        label: speakerLabel(relation, seat),
        relation,
        hero: input.heroOf(event.slot),
        spoken: 1,
        lastAt: event.at,
        lastText: event.text,
        events: [item]
      })
      continue
    }
    existing.events.push(item)
    existing.spoken += 1
    if (event.at >= existing.lastAt) {
      existing.lastAt = event.at
      existing.lastText = event.text
    }
  }
  const order: Record<SpeakerRelation, number> = { self: 0, teammate: 1, opponent: 2, unknown: 3 }
  const channels = [...bySlot.values()].sort((a, b) => order[a.relation] - order[b.relation] || a.slot - b.slot)
  return {
    matchid: input.matchid,
    channels,
    line: channelsLine(channels, input.mySlot),
    selfSlot: input.mySlot === null ? null : normalizeSlot(input.mySlot)
  }
}

/** 三种空态各一句话：没说话 / 认不出谁是谁 / 正常。绝不显示「五个灰频道」冒充数据。 */
export function channelsLine(channels: readonly SpeakerChannel[], mySlot: number | null): string {
  if (channels.length === 0) return '这局还没人说话'
  if (mySlot === null) return `这局有 ${channels.length} 个人说过话，但认不出谁是谁（拿不到自己的座位）`
  return `${channels.length} 个人说过话 · 我 ${countOf(channels, 'self')} 句 · 队友 ${countOf(channels, 'teammate')} 句 · 对手 ${countOf(channels, 'opponent')} 句`
}

function countOf(channels: readonly SpeakerChannel[], relation: SpeakerRelation): number {
  return channels.filter((one) => one.relation === relation).reduce((sum, one) => sum + one.spoken, 0)
}
