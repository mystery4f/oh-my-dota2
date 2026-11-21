/**
 * 逐人朗读开关（#93）：被静音的那个人一句都不念，其他人照念；设置重启后还在。
 *
 * 为什么这三条都要断言：静音做成「一句都不念」很容易，难的是**别误伤别人**——按座位标签
 * 匹配时把整组人都静音掉、或者解析不到昵称就默认静音，用户听到的是「突然不念了」而不是
 * 「这个人被关了」。所以这里既有纯判据，也有一次真落盘读回。
 */
import { finishProbe, probeCases } from './harness'
import { speakSkipReason } from '../services/voice/speech'
import { loadSettings, saveSettings } from '../services/settings'
import {
  EMPTY_MUTE_TABLE,
  formatMuteList,
  identityOf,
  isMuted,
  muteLine,
  muteTableOf,
  normalizeMuteList,
  parseMuteList
} from '@shared/speak-mute'

// 名单里静音的是「玩家3」与 nevermore，所以这里必须换一个人——否则这条断言自己就把人静音了。
const OTHER = '[玩家5] [路人甲] ⚔ 中路没人'

export function runSpeakMuteProbe(): void {
  const { cases, push } = probeCases()

  // —— 身份两路 ——
  const withHero = identityOf({ speaker: 'nevermore', original: '[玩家2] [小明] ⚔ 我先出个跳' })
  push('英雄短名与昵称两路都取到', withHero.hero === 'nevermore' && withHero.name === '玩家2', JSON.stringify(withHero))
  const noHero = identityOf({ original: '[玩家3] [路人甲] ⚔ 中路没人' })
  push('没有英雄块时 hero 为 null（不猜）', noHero.hero === null && noHero.name === '玩家3')
  const noBracket = identityOf({ original: '基地' })
  push('解析不到昵称就是 null，不是空串', noBracket.hero === null && noBracket.name === null)

  // —— 名单归一 ——
  push(
    '名单去空、去重、小写',
    normalizeMuteList([' 小明 ', 'A', '', 'a', '   ']).join(',') === '小明,a',
    normalizeMuteList([' 小明 ', 'A', '', 'a']).join(',')
  )
  push('输入框解析认逗号、顿号、空白', parseMuteList('玩家2，nevermore、小明 路人甲').length === 4)
  push('回显用顿号连接', formatMuteList(['a', 'b']) === 'a、b')

  const table = muteTableOf({ muteHeroes: ['NEVERMORE'], muteNames: ['玩家3'] })
  push('静音表归一后是小写', table.heroes[0] === 'nevermore' && table.names[0] === '玩家3')

  // —— 命中任一路就静音，其他人照念 ——
  push('按英雄短名命中', isMuted(table, identityOf({ speaker: 'nevermore', original: '[玩家2] [小明] ⚔ x' })))
  push('按昵称/座位名命中', isMuted(table, identityOf({ original: '[玩家3] [路人甲] ⚔ x' })))
  push('名单外的人不静音（不误伤）', !isMuted(table, identityOf({ speaker: 'lina', original: '[玩家4] [小红] ⚔ x' })))
  push('空名单不静音任何人', !isMuted(EMPTY_MUTE_TABLE, identityOf({ original: '[玩家3] ⚔ x' })))
  push('命中时不看大小写', isMuted(table, identityOf({ speaker: 'NEVERMORE', original: 'x' })))

  // —— 那一行：人数去重、零人时说清楚 ——
  push('那一行按去重后的人头数', muteLine({ heroes: ['a'], names: ['a', 'b'] }) === '静音 2 个：a、b', muteLine({ heroes: ['a'], names: ['a', 'b'] }))
  push('没人静音时说「所有人都念」', muteLine(EMPTY_MUTE_TABLE).includes('所有人都念'))

  // —— 说话链路上真的跳过：用不到设置，只喂 options ——
  const speakOptions = {
    readAloud: true,
    voice: 'x',
    rate: 1,
    pitch: 1,
    readOwn: false,
    prefix: 'off' as const,
    frontTpl: '{who}说，{body}',
    backTpl: '{body}，{who}表示',
    engine: 'edge' as const,
    muteTable: table
  }
  const entry = (original: string, speaker?: string) => ({
    id: 'x',
    ts: 1,
    original,
    body: original,
    translated: 'hi',
    speaker
  })
  push('被静音的人：跳过原因是 muted-player', speakSkipReason(entry('[玩家3] ⚔ x') as never, speakOptions as never) === 'muted-player')
  push('别人照常念（返回 null）', speakSkipReason(entry(OTHER) as never, speakOptions as never) === null)

  // —— 落盘：重启后还在（走真 saveSettings/loadSettings，探针根是临时数据目录） ——
  saveSettings({ ttsMuteNames: ['玩家3'], ttsMuteHeroes: ['nevermore'] })
  const back = loadSettings()
  push(
    '静音名单重启后还在',
    back.ttsMuteNames.join(',') === '玩家3' && back.ttsMuteHeroes.join(',') === 'nevermore',
    JSON.stringify(back.ttsMuteNames)
  )

  finishProbe('SPEAK_MUTE_PROBE', cases, { muted: muteLine(table) })
}