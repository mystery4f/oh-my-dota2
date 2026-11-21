/**
 * #161 驾驶室第一片：抬头事实行、频道行、三个热键提示。
 *
 * 逐字断言三句空态（pm 的签字要求），并把「缺块写 `—`」断言到**每一位**：
 * 英雄、等级、比赛时间、状态、帧龄各来一例——只断言「有 `—`」等于没断言。
 */

import { exitProbe, guardProbe, probeCases } from './harness'
import { formatAccelerator, UNBOUND_LABEL } from '@shared/hotkeys'
import {
  HELM_MUTE_NOTE,
  HELM_NO_CHANNELS,
  HELM_NO_SNAPSHOT,
  helmChannelsView,
  helmHead,
  helmHotkeyHints,
  oneLine
} from '@shared/helm'
import type { MatchSnapshot } from '@shared/match-snapshot'
import type { SpeakerChannel } from '@shared/speaker-channel'

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0)

function snap(
  overrides: Partial<Omit<MatchSnapshot, 'hero'>> & { hero?: Partial<NonNullable<MatchSnapshot['hero']>> } = {}
): MatchSnapshot {
  const { hero, ...rest } = overrides
  return {
    matchid: '7600111222',
    gameState: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS',
    clockTime: 183,
    gold: 1200,
    score: null,
    abilities: [],
    items: [],
    hero: { name: 'nevermore', level: 7, alive: true, respawnIn: null, ...hero },
    ...rest
  } as MatchSnapshot
}

function speaker(overrides: Partial<SpeakerChannel> = {}): SpeakerChannel {
  return {
    slot: 3,
    label: '队友 2',
    relation: 'teammate',
    hero: '',
    spoken: 2,
    lastAt: NOW - 5_000,
    lastText: '上高',
    events: [],
    ...overrides
  }
}

export async function runHelmEmptyProbe(): Promise<void> {
  guardProbe('HELM_EMPTY_PROBE')
  const { cases, push } = probeCases()

  // —— 空态一：没有快照。整条换一句话，不显示一排 —。——
  const noSnap = helmHead(null, null, NOW)
  push('没快照：标记为空、事实行清空', noSnap.empty && noSnap.facts.length === 0, `${noSnap.facts.length} 条`)
  push('没快照：文案逐字是「先把 GSI 那条连通」', noSnap.line === HELM_NO_SNAPSHOT, noSnap.line)

  // —— 空态二：有快照但缺块，每一位各写 —。——
  const empty = helmHead(
    snap({ matchid: null, clockTime: null, hero: { name: null, level: null, alive: null, respawnIn: null } }),
    null,
    NOW
  )
  const valueOf = (id: string): string => empty.facts.find((one) => one.id === id)?.value ?? 'MISSING'
  push('缺块：局号位写 —', valueOf('matchid') === '—', valueOf('matchid'))
  push('缺块：比赛时间位写 —', valueOf('clock') === '—', valueOf('clock'))
  push('缺块：英雄位写 —', valueOf('hero') === '—', valueOf('hero'))
  push('缺块：等级位写 —', valueOf('level') === '—', valueOf('level'))
  push('缺块：状态位写 —', valueOf('life') === '—', valueOf('life'))
  push('缺块：最后一帧写 —', valueOf('frame') === '—', valueOf('frame'))
  push('缺块：六位都不留空', empty.facts.every((one) => one.value !== ''), JSON.stringify(empty.facts.map((one) => one.value)))

  // —— 有快照的正常态：活着写「活着」，复活带前缀 ——
  const live = helmHead(snap(), NOW - 4_000, NOW)
  push('正常：六条事实且顺序固定', live.facts.map((one) => one.id).join(',') === 'matchid,clock,hero,level,life,frame', live.facts.map((one) => one.id).join(','))
  push('正常：活着那一格写「活着」而不是空', live.facts.find((one) => one.id === 'life')?.value === '活着', String(live.facts.find((one) => one.id === 'life')?.value))
  push('正常：等级带 Lv 前缀', live.facts.find((one) => one.id === 'level')?.value === 'Lv7', String(live.facts.find((one) => one.id === 'level')?.value))
  push('正常：比赛时间是 3:03', live.facts.find((one) => one.id === 'clock')?.value === '3:03', String(live.facts.find((one) => one.id === 'clock')?.value))
  push('正常：最后一帧说「4 秒前」（ageView 给 4.0 也算）', /4(\.0)? 秒前/.test(live.facts.find((one) => one.id === 'frame')?.value ?? ''), String(live.facts.find((one) => one.id === 'frame')?.value))
  const dead = helmHead(snap({ hero: { alive: false, respawnIn: 24 } }), NOW, NOW)
  push('阵亡：状态位是「复活 0:24」（带前缀，不与比赛时间混）', dead.facts.find((one) => one.id === 'life')?.value === '复活 0:24', String(dead.facts.find((one) => one.id === 'life')?.value))
  const selection = helmHead(snap({ clockTime: -24 }), NOW, NOW)
  push('选人：负数时间显示成 -0:24', selection.facts.find((one) => one.id === 'clock')?.value === '-0:24', String(selection.facts.find((one) => one.id === 'clock')?.value))

  // —— 空态三：没人说话，照抄 #160 ——
  const noChannel = helmChannelsView([], [])
  push('没频道：行清空、文案逐字是「这局还没人说话」', noChannel.rows.length === 0 && noChannel.line === HELM_NO_CHANNELS, noChannel.line)
  push('没频道：页尾仍然说清为什么没有静音按钮', noChannel.note === HELM_MUTE_NOTE, noChannel.note)

  // —— 频道行：没有英雄名就没有静音可言（不适用，不是「关」）——
  const plain = helmChannelsView([speaker(), speaker({ slot: 7, label: '对手 3', relation: 'opponent', lastText: 'gg' })], ['axe'])
  push('真对局：没有英雄名时 muteable=false，静音名单里有同名也不算', plain.rows.every((row) => !row.muteable && !row.muted), JSON.stringify(plain.rows.map((row) => [row.label, row.muteable, row.muted])))
  push('真对局：一行可静音的都没有时给页尾那句话', plain.note === HELM_MUTE_NOTE, plain.note)
  const known = helmChannelsView([speaker({ hero: 'axe' }), speaker({ slot: 7, hero: 'lina', label: '对手 3', relation: 'opponent' })], ['Axe'])
  push('拿到英雄名：该行才可静音、且按名字大小写不敏感匹配', known.rows[0]?.muteable === true && known.rows[0]?.muted === true && known.rows[1]?.muted === false, JSON.stringify(known.rows.map((row) => [row.hero, row.muteable, row.muted])))
  push('拿到英雄名：页尾不再说「要等拿到英雄名」', known.note === '', known.note)
  push('频道行：最近一句单行且超长截断', oneLine('第一行\n第二行  ' + 'x'.repeat(60)).includes('\n') === false && oneLine('x'.repeat(60)).length === 48, oneLine('x'.repeat(60)).length.toString())

  // —— 热键：活表取键名，改键跟着变；空的写「未绑定」——
  const hints = helmHotkeyHints({ voiceCapture: 'Alt+Shift+V', visionAsk: '', overlayPanel: 'Alt+Shift+H' }, formatAccelerator, UNBOUND_LABEL)
  push('热键：三个提示，标签是说话/看一眼/呼出', hints.map((one) => one.label).join(',') === '说话,看一眼,呼出', hints.map((one) => one.label).join(','))
  push('热键：键名来自活表而不是字面量', hints[0]?.key === formatAccelerator('Alt+Shift+V') && hints[2]?.key === formatAccelerator('Alt+Shift+H'), `${hints[0]?.key} / ${hints[2]?.key}`)
  push('热键：空绑定写「未绑定」并标记 unbound', hints[1]?.key === UNBOUND_LABEL && hints[1]?.unbound === true, String(hints[1]?.key))
  const rebound = helmHotkeyHints({ voiceCapture: 'Ctrl+Alt+Q', visionAsk: 'Ctrl+Alt+G', overlayPanel: 'Ctrl+Alt+P' }, formatAccelerator, UNBOUND_LABEL)
  push('热键：改键后界面跟着变', rebound[0]?.key === formatAccelerator('Ctrl+Alt+Q'), rebound[0]?.key ?? '')

  const failed = cases.filter((one) => !one.ok)
  for (const one of cases) console.log(`${one.ok ? 'PASS' : 'FAIL'} | ${one.name} | ${one.detail}`)
  console.log(`HELM_EMPTY_PROBE ${JSON.stringify({ ok: failed.length === 0, passed: cases.length - failed.length, failed: failed.length })}`)
  exitProbe(failed.length === 0)
}
