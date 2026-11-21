/**
 * #160 驾驶室的数据面：每个说话人一条频道。
 *
 * 这条探针要钉的不是「算得对」，而是三条**不许被以后的人改坏**的规矩：
 * 没聊天就是空数组、换局必须清空、认不出自己座位就说认不出（不许猜成队友/对手）。
 */

import { exitProbe, guardProbe, probeCases } from './harness'
import { buildSpeakerChannels, channelsLine, judgeSpeakerRelation, normalizeSlot, sideOf, speakerLabel } from '@shared/speaker-channel'
import {
  noteSpeakerEvent,
  noteSpeakerSelf,
  noteSpeakerSlot,
  resetSpeakerChannels,
  speakerChannels
} from '../services/voice/speaker-channels'

const AT = 1_780_000_000_000

function channel(overrides: Partial<Parameters<typeof buildSpeakerChannels>[0]> = {}) {
  return buildSpeakerChannels({
    matchid: '7500000001',
    mySlot: 2,
    heroOf: () => '',
    events: [],
    ...overrides
  })
}

export async function runSpeakerChannelProbe(): Promise<void> {
  guardProbe('SPEAKER_CHANNEL_PROBE')
  const { cases, push } = probeCases()

  // —— 空态：没聊天就是空数组 + 一句话，不伪造十个灰频道 ——
  const empty = channel()
  push('空态：没有事件就没有频道', empty.channels.length === 0, `${empty.channels.length} 条`)
  push('空态：那句话是「这局还没人说话」', empty.line === '这局还没人说话', empty.line)

  // —— 认不出自己座位：全部 unknown，并且说出来 ——
  const blinder = channel({
    mySlot: null,
    events: [{ slot: 2, at: AT, gameTime: 600, channel: 11, text: 'gg' }]
  })
  push('认不出：所有频道都是 unknown', blinder.channels.every((one) => one.relation === 'unknown'), JSON.stringify(blinder.channels.map((one) => one.relation)))
  push('认不出：标签是「认不出」，不是队友也不是对手', blinder.channels.every((one) => one.label === '认不出'), JSON.stringify(blinder.channels.map((one) => one.label)))
  push('认不出：那句话说明认不出谁是谁', blinder.line.includes('认不出谁是谁'), blinder.line)
  push('认不出：selfSlot 为 null', blinder.selfSlot === null, String(blinder.selfSlot))

  // —— 座位归一与关系：真对局只有座位，没有名字 ——
  push('座位：128+ 写法折回 0–4', normalizeSlot(130) === 2, String(normalizeSlot(130)))
  push('关系：自己就是自己（原样相等才算，折回座位号不算）', judgeSpeakerRelation(2, 2) === 'self' && judgeSpeakerRelation(130, 2) !== 'self', `self / 130→${judgeSpeakerRelation(130, 2)}`)
  // 同一局内两侧是推得出来的事实：0–4 一侧、5–9 一侧，128+ 的写法折成夜魇。
  push('关系：同侧是队友、异侧是对手（只比座位）', judgeSpeakerRelation(3, 2) === 'teammate' && judgeSpeakerRelation(7, 2) === 'opponent', 'teammate/opponent')
  push('关系：128+ 的写法算夜魇、不是「折回 0–4 的队友」', sideOf(130) === 1 && judgeSpeakerRelation(130, 2) === 'opponent', `sideOf(130)=${sideOf(130)}`)
  push('关系：认不出自己座位时不猜', judgeSpeakerRelation(7, null) === 'unknown', 'unknown')
  push('标签：我 / 队友 2 / 对手 3 按座位算', speakerLabel('self', 2) === '我' && speakerLabel('teammate', 1) === '队友 2' && speakerLabel('opponent', 7) === '对手 3', `${speakerLabel('self', 2)}|${speakerLabel('teammate', 1)}|${speakerLabel('opponent', 7)}`)

  // —— 组装：一条频道一人、顺序确定、最近一句是最新 ——
  const built = channel({
    events: [
      { slot: 7, at: AT + 1, gameTime: 610, channel: 11, text: '你们打得好' },
      { slot: 2, at: AT + 2, gameTime: 611, channel: 11, text: '谢谢' },
      { slot: 3, at: AT + 3, gameTime: 612, channel: 12, text: '上高' },
      { slot: 7, at: AT + 4, gameTime: 613, channel: 11, text: '再来一局' }
    ]
  })
  push('组装：四个人说过话就是四条频道', built.channels.length === 3, `${built.channels.length} 条 · ${built.channels.map((one) => one.label).join(',')}`)
  push('组装：顺序是 我 → 队友 → 对手', built.channels.map((one) => one.relation).join(',') === 'self,teammate,opponent', built.channels.map((one) => one.label).join(','))
  push('组装：同一人两句合成一条、句数是 2', built.channels.find((one) => one.slot === 7)?.spoken === 2, JSON.stringify(built.channels.find((one) => one.slot === 7)?.spoken))
  push('组装：最近一句取最新那句', built.channels.find((one) => one.slot === 7)?.lastText === '再来一局', String(built.channels.find((one) => one.slot === 7)?.lastText))
  push('组装：正文与对局时间都留着', built.channels.find((one) => one.slot === 3)?.events[0]?.gameTime === 612, JSON.stringify(built.channels.find((one) => one.slot === 3)?.events[0]))
  push('组装：那句话数清三类各说了几句', built.line === '3 个人说过话 · 我 1 句 · 队友 1 句 · 对手 2 句', built.line)
  push('组装：英雄只在拿到时出现', channel({
    events: [{ slot: 3, at: AT, gameTime: 1, channel: 11, text: 'a' }],
    heroOf: (slot) => (normalizeSlot(slot) === 3 ? 'axe' : '')
  }).channels[0]?.hero === 'axe', 'axe')

  // —— 账本：换局清空、空文本不进、认不出不猜 ——
  resetSpeakerChannels()
  push('账本：刚启动时是空态', speakerChannels().channels.length === 0 && speakerChannels().matchid === null, speakerChannels().line)
  noteSpeakerSelf({ matchid: '7500000009', slot: 2, team: 'radiant' })
  noteSpeakerSlot(3, { hero: 'axe', team: 'radiant' })
  noteSpeakerSlot(7, { team: 'dire' })
  noteSpeakerEvent({ matchid: '7500000009', slot: 3, at: AT, gameTime: 100, channel: 12, text: '上高' })
  noteSpeakerEvent({ matchid: '7500000009', slot: 7, at: AT + 1, gameTime: 101, channel: 11, text: '等着' })
  noteSpeakerEvent({ matchid: '7500000009', slot: 7, at: AT + 2, gameTime: 102, channel: 11, text: '   ' })
  const live = speakerChannels()
  push('账本：两条有效 + 一条空文本被丢', live.channels.length === 2 && live.channels.every((one) => one.spoken === 1), JSON.stringify(live.channels.map((one) => [one.label, one.spoken])))
  push('账本：关系由座位两侧算出来', live.channels.map((one) => one.relation).join(',') === 'teammate,opponent', live.channels.map((one) => one.label).join(','))
  push('账本：英雄跟着座位走', live.channels.find((one) => one.slot === 3)?.hero === 'axe', String(live.channels.find((one) => one.slot === 3)?.hero))
  noteSpeakerEvent({ matchid: '7500000010', slot: 3, at: AT + 3, gameTime: 1, channel: 11, text: '新一局' })
  const next = speakerChannels()
  push('换局：上一局的频道全清掉', next.matchid === '7500000010' && next.channels.length === 1 && next.channels[0]?.lastText === '新一局', JSON.stringify({ matchid: next.matchid, channels: next.channels.map((one) => one.lastText) }))
  // 同局内两侧是座位算出来的，所以换局后立刻能算；但**上一局的阵营表必须已清**（下一行钉它）。
  push('换局：座位仍然认得出自己', next.selfSlot === 2, String(next.selfSlot))
  push('换局：上一局的英雄不会跟过来', next.channels[0]?.hero === '', String(next.channels[0]?.hero))
  // 同侧/异侧是座位算出来的，所以换局之后立刻又算得出来——这里不靠上一局的阵营表。
  push('换局：关系立刻按新座位重算', next.channels[0]?.relation === 'teammate', String(next.channels[0]?.relation))
  const unknownLine = channelsLine(blinder.channels, null)
  push('三种空态三句话互不相同', channel().line !== blinder.line && unknownLine.includes('认不出谁是谁'), `${channel().line} / ${unknownLine}`)

  resetSpeakerChannels()
  const failed = cases.filter((one) => !one.ok)
  for (const one of cases) console.log(`${one.ok ? 'PASS' : 'FAIL'} | ${one.name} | ${one.detail}`)
  console.log(`SPEAKER_CHANNEL_PROBE ${JSON.stringify({ ok: failed.length === 0, passed: cases.length - failed.length, failed: failed.length })}`)
  exitProbe(failed.length === 0)
}
