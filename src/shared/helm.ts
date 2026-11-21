/**
 * 驾驶室（#161）第一片的纯缝：抬头事实行、频道行、热键提示、三种空态。
 *
 * 这里**只算值，不画界面**。理由是三条判据都要求逐字可断言：
 * 缺块写 `—`（每一位各一例）、没快照写「先把 GSI 那条连通」、没人说话写「这局还没人说话」。
 * 把这些写进组件，断言就只能靠截图；写进这里，探针能一条条数。
 *
 * 两条口径来自 pm 的签字，改动先问：
 * - `DEFAULT_SECTION` 仍是 `overview`，本票不换默认落地页。
 * - 复活倒计时**活着时那一位写「活着」**，不留空——空格子和「没这项」在屏幕上长得一样。
 */

import { ageView, clockText } from './board-view'
import { isRealMatchId } from './match-id'
import type { MatchSnapshot } from './match-snapshot'
import type { SpeakerChannel } from './speaker-channel'

/** 抬头行的六个事实，顺序固定：一眼扫下去不能每次换位置。 */
export type HelmFactId = 'matchid' | 'clock' | 'hero' | 'level' | 'life' | 'frame'

/**
 * GSI 给的英雄是 `npc_dota_hero_nevermore` 这种内部名：抬头只有一格位置，
 * 留前缀会把整行推出屏幕（实测在 853 px 宽里被截断）。这里只做展示收窄，
 * 不改任何数据源。
 */
function heroLabel(name: string | null): string {
  const raw = (name ?? '').trim()
  if (raw === '') return '—'
  return raw.replace(/^npc_dota_hero_/i, '')
}

export interface HelmFact {
  id: HelmFactId
  label: string
  /** 缺失一律 `—`，绝不留空、绝不填 0。 */
  value: string
}

export interface HelmHead {
  facts: HelmFact[]
  /** 没有快照时为 true：整条换成一句话，不显示一排 `—` 冒充数据。 */
  empty: boolean
  /** 空态那一句话；有快照时为空串。 */
  line: string
}

/** 没快照时整条说的那句话。 */
export const HELM_NO_SNAPSHOT = '先把 GSI 那条连通'
/** 频道为空时那句话，照抄 #160。 */
export const HELM_NO_CHANNELS = '这局还没人说话'
/** 真对局拿不到别人的名字，所以按人静音这一片没有按钮——页尾把原因说出来。 */
export const HELM_MUTE_NOTE =
  'GSI 不给别人的名字，按人静音要等拿到英雄名；现在只能在「不念谁」里按名字写'

const DASH = '—'

function fact(id: HelmFactId, label: string, value: string | null): HelmFact {
  return { id, label, value: value === null || value === '' ? DASH : value }
}

/**
 * 抬头行。`gsiLastAt` 来自 `captureStatus().gsi.lastAt`（**不是** MatchSnapshot 的字段），
 * 这里只算「N 秒前」，不判断断流——断流归 `gsi-stall.ts`。
 */
export function helmHead(snapshot: MatchSnapshot | null, gsiLastAt: number | null, now: number): HelmHead {
  if (snapshot === null) {
    return { facts: [], empty: true, line: HELM_NO_SNAPSHOT }
  }
  const hero = snapshot.hero
  // 活着写「活着」；死了写「复活 0:24」；两者都不知道才写 —。
  const life = hero.alive === true ? '活着' : hero.alive === false ? (hero.respawnIn === null ? '阵亡' : `复活 ${clockText(hero.respawnIn)}`) : null
  return {
    empty: false,
    line: '',
    facts: [
      fact('matchid', '局号', snapshot.matchid),
      fact('clock', '比赛时间', clockText(snapshot.clockTime)),
      fact('hero', '英雄', hero.name === null ? null : heroLabel(hero.name)),
      fact('level', '等级', hero.level === null ? null : `Lv${hero.level}`),
      fact('life', '状态', life),
      fact('frame', '最后一帧', gsiLastAt === null ? null : ageView(gsiLastAt, now).text)
    ]
  }
}

export interface HelmChannelRow {
  slot: number
  /** `我` / `队友 2` / `对手 3` / `认不出` —— 座位推出来的，不是名字。 */
  label: string
  /** 最近一句，**必定是单行**：换行会把行高撑开，一屏就看不见几个频道了。 */
  lastText: string
  spoken: number
  /** 拿到英雄名才有静音可言；没名字时这一行连状态都不显示（不适用，不是「关」）。 */
  hero: string
  muteable: boolean
  muted: boolean
}

export interface HelmChannelsView {
  rows: HelmChannelRow[]
  /** 空态那一句话（照抄 #160）；有频道时为空串。 */
  line: string
  /** 一个可静音的都没有时给页尾那句；有可静音行时为空串。 */
  note: string
}

/** 「最近一句」截断成一行：`text-overflow: ellipsis` 由组件负责，这里只保证不夹换行。 */
export function oneLine(text: string, maxChars = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`
}

export function helmChannelsView(
  channels: readonly SpeakerChannel[],
  mutedHeroes: readonly string[]
): HelmChannelsView {
  const muted = new Set(mutedHeroes.map((name) => name.trim().toLowerCase()).filter((name) => name !== ''))
  const rows = channels.map((one) => ({
    slot: one.slot,
    label: one.label,
    lastText: oneLine(one.lastText),
    spoken: one.spoken,
    hero: one.hero,
    muteable: one.hero.trim() !== '',
    muted: one.hero.trim() !== '' && muted.has(one.hero.trim().toLowerCase())
  }))
  return {
    rows,
    line: rows.length === 0 ? HELM_NO_CHANNELS : '',
    note: rows.some((row) => row.muteable) ? '' : HELM_MUTE_NOTE
  }
}

export interface HelmHotkeyHint {
  id: 'voiceCapture' | 'visionAsk' | 'overlayPanel'
  label: string
  /** 活表里的键名（`formatAccelerator` 的结果）；没绑定就是「未绑定」。 */
  key: string
  unbound: boolean
}

const HOTKEY_HINTS: readonly { id: HelmHotkeyHint['id']; label: string }[] = [
  { id: 'voiceCapture', label: '说话' },
  { id: 'visionAsk', label: '看一眼' },
  { id: 'overlayPanel', label: '呼出' }
]

/**
 * 三个热键提示。键名一律从**活表**来，改键后界面跟着变——这里不写任何字面量快捷键。
 */
export function helmHotkeyHints(hotkeys: Readonly<Record<string, string>>, display: (accelerator: string) => string, unboundLabel: string): HelmHotkeyHint[] {
  return HOTKEY_HINTS.map((one) => {
    const accelerator = (hotkeys[one.id] ?? '').trim()
    return {
      id: one.id,
      label: one.label,
      key: accelerator === '' ? unboundLabel : display(accelerator),
      unbound: accelerator === ''
    }
  })
}
/* ——— 第二片（issue #165）：三个固定动作 + 监听行 ——— */

/** 页面能用到的动作 id：与热键表同名，改键后按钮跟着变。 */
export type HelmActionId = 'voiceCapture' | 'visionAsk' | 'overlayPanel'

/** 没绑键时按钮上那句话。 */
export const HELM_ACTION_UNBOUND = '这个动作还没绑键'
/** 浮层关着时「呼出」没法用的原因；这不是失败，是当前状态。 */
export const HELM_ACTION_OVERLAY_OFF = '浮层现在是关的'
/** 看一眼在跑：期间必须禁用，否则连点就是连着花老板的钱。 */
export const HELM_ACTION_LOOKING = '正在看…'
/** 说话刚触发过（500 ms 去抖挡掉的连点）：说一句，不静默。 */
export const HELM_ACTION_BUSY = '刚触发过，稍等半秒'
/** 监听行：帧龄为空。 */
export const HELM_LISTEN_NO_FRAME = '还没收到过一帧'
/** 监听行：这一局没有可播报的事（也用于「时间线属上一局」——不显示别人那一局）。 */
export const HELM_LISTEN_NO_EVENT = '这一局还没发生可播报的事'
/** captureStatus() 自己挂了：与「没帧」「没事件」必须是三句话。 */
export const HELM_LISTEN_UNREADABLE = '状态读不到'

export interface HelmAction {
  id: HelmActionId
  label: string
  /** 活表里的键名；未绑定就是「未绑定」。 */
  key: string
  unbound: boolean
  /** 现在能不能点。 */
  enabled: boolean
  /** **恰好一句**原因或状态（可用时为空串）——禁止两个原因叠着写。 */
  note: string
}

export interface HelmActionsInput {
  hotkeys: Readonly<Record<string, string>>
  display: (accelerator: string) => string
  unboundLabel: string
  /** 浮层当前可见吗：不可见时「呼出」没有可呼的对象。 */
  overlayVisible: boolean
  /** 正在录音吗（真值来自浮层的采集上报）。 */
  recording: boolean
  /** 看一眼正在跑吗。 */
  looking: boolean
  /** 说话按钮刚被去抖挡回来吗。 */
  captureBusy: boolean
}

const ACTION_LABELS: readonly { id: HelmActionId; label: string }[] = [
  { id: 'voiceCapture', label: '说话' },
  { id: 'visionAsk', label: '看一眼' },
  { id: 'overlayPanel', label: '呼出' }
]

/**
 * 三个固定动作的可用状态。优先级只有一条：**没绑键压倒一切**（没绑就点不动，
 * 别的原因都无从谈起）；其余各自最多一句，绝不互相覆盖。
 */
export function helmActions(input: HelmActionsInput): HelmAction[] {
  return ACTION_LABELS.map((one) => {
    const accelerator = (input.hotkeys[one.id] ?? '').trim()
    const unbound = accelerator === ''
    const key = unbound ? input.unboundLabel : input.display(accelerator)
    if (unbound) return { ...one, key, unbound, enabled: false, note: HELM_ACTION_UNBOUND }
    if (one.id === 'overlayPanel' && !input.overlayVisible) {
      return { ...one, key, unbound, enabled: false, note: HELM_ACTION_OVERLAY_OFF }
    }
    if (one.id === 'visionAsk' && input.looking) {
      return { ...one, key, unbound, enabled: false, note: HELM_ACTION_LOOKING }
    }
    if (one.id === 'voiceCapture') {
      if (input.captureBusy) return { ...one, key, unbound, enabled: false, note: HELM_ACTION_BUSY }
      return { ...one, key, unbound, enabled: true, note: input.recording ? '录音中' : '' }
    }
    return { ...one, key, unbound, enabled: true, note: '' }
  })
}

/** 一句话说完：错误文本只取第一句，超出就截断（面板一行放不下整段栈）。 */
export function firstSentence(text: string, maxChars = 48): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  const cut = flat.search(/[。！？!?\n]/)
  const head = cut < 0 ? flat : flat.slice(0, cut)
  return head.length <= maxChars ? head : `${head.slice(0, maxChars - 1)}…`
}

export interface HelmListenHalf {
  text: string
  tone: 'ok' | 'warn' | 'bad' | 'dim'
}

export interface HelmListenLine {
  /** 左半：它在听什么（GSI 帧龄三档）。 */
  left: HelmListenHalf
  /** 右半：刚说了什么（时间线最新一条）。 */
  right: HelmListenHalf
  /** 时间线属别的局：界面该知道「被藏掉了」，探针也据此断言。 */
  crossMatch: boolean
}

export interface HelmListenInput {
  /** captureStatus().gsi.lastAt。 */
  gsiLastAt: number | null
  now: number
  /** captureStatus() 自己抛错时的原文（取第一句）。 */
  captureError?: string | null
  /** 当前快照的局号（null = 没快照）。 */
  snapshotMatchId: string | null
  /** 时间线视图（null = 还没取到）。 */
  timeline: { matchid: string; entries: readonly { gameTime: number; text: string }[] } | null
}

/**
 * 监听行。三种「没东西」必须三句话，谁都不许冒充谁：
 * 读不到状态 / 还没收到过一帧 / 这一局还没发生可播报的事。
 *
 * 跨局那条更狠：时间线的局号与当前快照对不上，就当这一局还没事发生——
 * 把上一局的事贴到这一局，是本票最贵的错误。
 */
export function helmListenLine(input: HelmListenInput): HelmListenLine {
  const error = (input.captureError ?? '').trim()
  const left: HelmListenHalf =
    error !== ''
      ? { text: `${HELM_LISTEN_UNREADABLE}：${firstSentence(error)}`, tone: 'bad' }
      : input.gsiLastAt === null
        ? { text: HELM_LISTEN_NO_FRAME, tone: 'dim' }
        : ageView(input.gsiLastAt, input.now)

  const timeline = input.timeline
  const sameMatch =
    timeline !== null &&
    isRealMatchId(timeline.matchid) &&
    input.snapshotMatchId !== null &&
    timeline.matchid === input.snapshotMatchId
  const newest = timeline === null || !sameMatch ? null : (timeline.entries[0] ?? null)
  // text 本来就是人话（`智慧符刷新了`），只补时间，不拼 kind。
  const right: HelmListenHalf =
    newest === null
      ? { text: HELM_LISTEN_NO_EVENT, tone: 'dim' }
      : { text: `${clockText(newest.gameTime)} ${newest.text}`, tone: 'ok' }
  const crossMatch =
    timeline !== null &&
    isRealMatchId(timeline.matchid) &&
    timeline.matchid !== (input.snapshotMatchId ?? '')
  return { left, right, crossMatch }
}