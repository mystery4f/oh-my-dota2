/**
 * #161 驾驶室第一片：抬头事实行、频道行、三个热键提示。
 * #165 第二片：三个固定动作的可用状态、监听行（三档帧龄 + 三种「没东西」+ 跨局不串人）。
 * #167 第三片：频道静音（名单去空白/移除/不许重复）与一句话链（只留一条、跨局不显示、失败截一句）。
 *
 * 逐字断言三句空态（pm 的签字要求），并把「缺块写 `—`」断言到**每一位**：
 * 英雄、等级、比赛时间、状态、帧龄各来一例——只断言「有 `—`」等于没断言。
 */

import { exitProbe, guardProbe, probeCases } from './harness'
import { formatAccelerator, UNBOUND_LABEL } from '@shared/hotkeys'
import { chainLast, noteChainLast, resetChainLastForProbe } from '../services/voice/chain-last'
import {
  HELM_ACTION_BUSY,
  HELM_CHAIN_NEVER,
  HELM_CHAIN_NO_MATCH,
  HELM_CHAIN_OTHER_MATCH,
  HELM_CHAIN_UNREADABLE,
  helmChainLine,
  muteToggle,
  HELM_ACTION_LOOKING,
  HELM_ACTION_OVERLAY_OFF,
  HELM_ACTION_UNBOUND,
  HELM_LISTEN_NO_EVENT,
  HELM_LISTEN_NO_FRAME,
  HELM_LISTEN_UNREADABLE,
  helmActions,
  helmListenLine
} from '@shared/helm'
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


  // ——— 第二片（#165）：三个动作的可用状态 ———
  const allBound = { voiceCapture: 'Alt+Shift+V', visionAsk: 'Alt+Shift+G', overlayPanel: 'Alt+Shift+H' }
  const baseActions = {
    display: formatAccelerator,
    unboundLabel: UNBOUND_LABEL,
    overlayVisible: true,
    recording: false,
    looking: false,
    captureBusy: false
  }
  const bound = helmActions({ ...baseActions, hotkeys: allBound })
  push('动作：三个都绑时全部可点', bound.length === 3 && bound.every((one) => one.enabled && one.note === ''), JSON.stringify(bound.map((one) => [one.id, one.enabled, one.note])))
  const noneBound = helmActions({ ...baseActions, hotkeys: { voiceCapture: '', visionAsk: '', overlayPanel: '' } })
  push('动作：三个都未绑时全部禁用且都写「没绑键」', noneBound.every((one) => !one.enabled && one.note === HELM_ACTION_UNBOUND), JSON.stringify(noneBound.map((one) => one.note)))
  const oneBound = helmActions({ ...baseActions, hotkeys: { ...allBound, visionAsk: '' } })
  push('动作：只绑一个时只禁用它自己', oneBound[1].enabled === false && oneBound[1].note === HELM_ACTION_UNBOUND && oneBound[0].enabled && oneBound[2].enabled, JSON.stringify(oneBound.map((one) => [one.id, one.enabled])))
  const overlayOff = helmActions({ ...baseActions, hotkeys: allBound, overlayVisible: false })
  push('动作：浮层关着时只有「呼出」禁用，原因说清是浮层关着', overlayOff[2].enabled === false && overlayOff[2].note === HELM_ACTION_OVERLAY_OFF && overlayOff[0].enabled, JSON.stringify(overlayOff.map((one) => one.note)))
  const lookingNow = helmActions({ ...baseActions, hotkeys: allBound, looking: true })
  push('动作：看着画面时「看一眼」禁用（连点就是连花钱）', lookingNow[1].enabled === false && lookingNow[1].note === HELM_ACTION_LOOKING, String(lookingNow[1].note))
  const busy = helmActions({ ...baseActions, hotkeys: allBound, captureBusy: true })
  push('动作：说话被去抖挡回来时说一句，不静默', busy[0].enabled === false && busy[0].note === HELM_ACTION_BUSY, String(busy[0].note))
  const recNow = helmActions({ ...baseActions, hotkeys: allBound, recording: true })
  push('动作：录音中时说话按钮仍可点（再按一次就是停），并标「录音中」', recNow[0].enabled === true && recNow[0].note === '录音中', String(recNow[0].note))
  const clash = helmActions({ ...baseActions, hotkeys: { ...allBound, visionAsk: '' }, overlayVisible: false, looking: true })
  push('动作：多个原因同时成立时每行仍只有一句、互不覆盖', clash.every((one) => one.note === '' || one.note.length <= 16) && clash[1].note === HELM_ACTION_UNBOUND, JSON.stringify(clash.map((one) => one.note)))

  // ——— 第二片：监听行（三档帧龄 + 三种「没东西」 + 跨局）———
  const nowMs = NOW
  const freshLine = helmListenLine({ gsiLastAt: nowMs - 800, now: nowMs, snapshotMatchId: '9061502086', timeline: { matchid: '9061502086', entries: [{ gameTime: 420, text: '智慧符刷新了' }] } })
  push('监听：帧龄新时左半是「N.N 秒前」的 ok 档', freshLine.left.text === '0.8 秒前' && freshLine.left.tone === 'ok', freshLine.left.text)
  push('监听：右半是「时间 + 人话」，不拼 kind', freshLine.right.text === '7:00 智慧符刷新了' && !freshLine.right.text.includes('wisdom'), freshLine.right.text)
  const staleLine = helmListenLine({ gsiLastAt: nowMs - 12_000, now: nowMs, snapshotMatchId: '9061502086', timeline: null })
  push('监听：帧龄偏旧时是 warn 档', staleLine.left.tone === 'warn', staleLine.left.text)
  const deadLine = helmListenLine({ gsiLastAt: nowMs - 5 * 60_000, now: nowMs, snapshotMatchId: '9061502086', timeline: null })
  push('监听：早断了时是 bad 档并说「早断了」', deadLine.left.tone === 'bad' && deadLine.left.text.includes('早断了'), deadLine.left.text)
  const noFrame = helmListenLine({ gsiLastAt: null, now: nowMs, snapshotMatchId: null, timeline: null })
  push('监听：「没帧」与「没事件」与「读不到」是三句话', noFrame.left.text === HELM_LISTEN_NO_FRAME && noFrame.right.text === HELM_LISTEN_NO_EVENT, JSON.stringify([noFrame.left.text, noFrame.right.text]))
  const unreadable = helmListenLine({ gsiLastAt: null, now: nowMs, captureError: 'ipc 超时：主进程没有回应。还有后半句不该出现', snapshotMatchId: null, timeline: null })
  push('监听：状态读不到时只取第一句并截断', unreadable.left.tone === 'bad' && unreadable.left.text.startsWith(HELM_LISTEN_UNREADABLE + '：') && !unreadable.left.text.includes('后半句'), unreadable.left.text)
  const emptyTimeline = helmListenLine({ gsiLastAt: nowMs - 900, now: nowMs, snapshotMatchId: '9061502086', timeline: { matchid: '9061502086', entries: [] } })
  push('监听：时间线为空时右半说「这局还没发生可播报的事」', emptyTimeline.right.text === HELM_LISTEN_NO_EVENT && emptyTimeline.crossMatch === false, emptyTimeline.right.text)
  const crossLine = helmListenLine({ gsiLastAt: nowMs - 900, now: nowMs, snapshotMatchId: '9061502086', timeline: { matchid: '7512345678', entries: [{ gameTime: 1200, text: '肉山复活了' }] } })
  push('监听：时间线属上一局时一条都不显示（跨局串人是最贵的错）', crossLine.right.text === HELM_LISTEN_NO_EVENT && crossLine.crossMatch === true, crossLine.right.text)
  push('监听：跨局时左半照常报帧龄（帧是这一局的）', crossLine.left.tone === 'ok', crossLine.left.text)
  const notRealId = helmListenLine({ gsiLastAt: nowMs - 900, now: nowMs, snapshotMatchId: '0', timeline: { matchid: '0', entries: [{ gameTime: 30, text: '不该显示' }] } })
  push('监听：matchid 为 "0"（菜单/训练场）不算对局，不显示任何事件', notRealId.right.text === HELM_LISTEN_NO_EVENT, notRealId.right.text)


  // ——— 第三片（#167）：频道静音（名单只有一份，规则只在纯缝里） ———
  const zero = muteToggle([], 'axe')
  push('静音：空名单点一下 = 加进去', zero.changed && zero.next.join(',') === 'axe', JSON.stringify(zero))
  const added = muteToggle(['axe'], 'lina')
  push('静音：已有别人时追加在后面（不改原有顺序）', added.next.join(',') === 'axe,lina', added.next.join(','))
  const removed = muteToggle(['axe', 'lina'], 'axe')
  push('静音：已在名单里再点一次是移除，不是重复添加', removed.changed && removed.next.join(',') === 'lina', JSON.stringify(removed.next))
  const back = muteToggle(removed.next, 'axe')
  push('静音：加回来是追加在末尾（不改已有顺序）', back.next.join(',') === 'lina,axe', back.next.join(','))
  const blank = muteToggle(['axe'], '   ')
  push('静音：空白英雄名一律不写（reason=blank，且名单不变）', !blank.changed && blank.reason === 'blank' && blank.next.join(',') === 'axe', JSON.stringify(blank))
  const twice = muteToggle(['axe'], 'axe ')
  push('静音：名字先 trim 再比（"axe " 也算已在名单）', twice.changed && twice.next.length === 0, JSON.stringify(twice.next))

  // ——— 第三片：最后一条对讲（只在内存、只留一条、不带上一局的 id） ———
  resetChainLastForProbe()
  push('一句话链：刚启动时读口是 null（不是空串）', chainLast() === null, String(chainLast()))
  const stubSummary = {
    transcript: '对面中单不见了',
    translated: 'Their mid is missing.',
    spoken: true,
    stage: null,
    error: null,
    sink: 'CABLE Input (VB-Audio Virtual Cable)'
  }
  noteChainLast(stubSummary as never, null)
  push('一句话链：不在对局时 matchid 照实存 null，不回填上一局', chainLast()?.matchid === null, JSON.stringify(chainLast()?.matchid))
  noteChainLast(stubSummary as never, '7600111222')
  push('一句话链：只留最后一条（后写覆盖前写）', chainLast()?.matchid === '7600111222' && chainLast()?.summary.transcript === '对面中单不见了', JSON.stringify(chainLast()?.matchid))
  push('一句话链：留的是同一份内容，不重新合成', chainLast()?.summary === stubSummary, String(chainLast()?.summary === stubSummary))

  // ——— 第三片：一句话链的界面判定 ———
  const chainSame = helmChainLine({ latest: { ...stubSummary, matchid: '7600111222' }, snapshotMatchId: '7600111222' })
  push('一句话链：同局时听到原话、说了译文并带上灌入设备', chainSame.heard.text === '对面中单不见了' && chainSame.said.text.includes('灌入「CABLE Input') && chainSame.empty === null, chainSame.said.text)
  const chainNoSink = helmChainLine({ latest: { ...stubSummary, sink: undefined, matchid: '7600111222' }, snapshotMatchId: '7600111222' })
  push('一句话链：没有灌入设备时不写「灌入」半句', !chainNoSink.said.text.includes('灌入'), chainNoSink.said.text)
  const chainNever = helmChainLine({ latest: null, snapshotMatchId: '7600111222' })
  push('一句话链：还没对讲过是一句独立空态', chainNever.empty === HELM_CHAIN_NEVER && chainNever.heard.tone === 'dim', String(chainNever.empty))
  const chainNoMatch = helmChainLine({ latest: { ...stubSummary, matchid: null }, snapshotMatchId: '7600111222' })
  push('一句话链：不在对局里是另一句，且不显示内容', chainNoMatch.empty === HELM_CHAIN_NO_MATCH, String(chainNoMatch.empty))
  const chainOther = helmChainLine({ latest: { ...stubSummary, matchid: '7512345678' }, snapshotMatchId: '7600111222' })
  push('一句话链：上一句属别的局时一条都不显示', chainOther.empty === HELM_CHAIN_OTHER_MATCH && !chainOther.said.text.includes('mid is missing'), String(chainOther.empty))
  const chainFail = helmChainLine({
    latest: { ...stubSummary, matchid: '7600111222', spoken: false, stage: 'voice-out', error: '声出失败：Edge 返回 0 字节。后面的细节'.padEnd(200, '很') },
    snapshotMatchId: '7600111222'
  })
  push('一句话链：失败行带阶段，原因截到一句（不超过 80 字 + 前缀）', chainFail.failure?.startsWith('卡在 voice-out：') === true && (chainFail.failure?.length ?? 0) <= 96, String(chainFail.failure?.length))
  push('一句话链：失败时仍显示听到的那句（别把前半段也弄丢）', chainFail.heard.text === '对面中单不见了', chainFail.heard.text)
  const chainReadErr = helmChainLine({ latest: null, snapshotMatchId: null, readError: 'ipc 通道断了。后面的话不该出现' })
  push('一句话链：读口出错单独一句，只取第一句', chainReadErr.empty?.startsWith(HELM_CHAIN_UNREADABLE) === true && !chainReadErr.empty?.includes('后面的话'), String(chainReadErr.empty))

  const failed = cases.filter((one) => !one.ok)
  for (const one of cases) console.log(`${one.ok ? 'PASS' : 'FAIL'} | ${one.name} | ${one.detail}`)
  console.log(`HELM_EMPTY_PROBE ${JSON.stringify({ ok: failed.length === 0, passed: cases.length - failed.length, failed: failed.length })}`)
  exitProbe(failed.length === 0)
}
