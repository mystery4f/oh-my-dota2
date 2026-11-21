/**
 * --match-snapshot-probe：副屏面板的数据层（#124b）。
 *
 * 钉三件事：字段齐全（合成帧喂进去能读出来）、缺块只填 null 不告警、技能只留等级。
 * 「不许第二份 GSI reader」这条不靠探针——`noteSnapshot()` 的入参就是 `gsi.ts` 解析完的那一帧。
 */
import { judgeGsiStall } from '@shared/gsi-stall'
import { emptySnapshot, snapshotLine, snapshotOf } from '@shared/match-snapshot'
import { currentSnapshot, noteSnapshot, resetSnapshot, matchSnapshotPath } from '../services/match-snapshot'
import { logsDir } from '../services/logs/base-dir'
import { finishProbe, probeCases } from './harness'
import { join } from 'node:path'

const fullFrame = {
  map: { matchid: '7600111222', game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', clock_time: 183, daytime: true },
  hero: {
    name: 'npc_dota_hero_nevermore',
    level: 7,
    alive: true,
    gold: 1200,
    kills: 3,
    deaths: 1,
    assists: 5
  },
  abilities: {
    ability_0: { name: 'nevermore_shadowraze1', level: 4, cooldown: 4 },
    ability_1: { name: 'nevermore_necromastery', level: 2 },
    ability_2: { name: 'nevermore_presence', level: 0 },
    ability_3: { name: 'nevermore_requiem', level: 1 }
  },
  items: {
    slot0: { name: 'item_blink', id: 1 },
    slot1: { name: 'empty', id: 0 },
    slot2: { id: 127 }
  }
}

export function runMatchSnapshotProbe(): void {
  const { cases, push } = probeCases()
  resetSnapshot()

  const snap = snapshotOf(fullFrame, 1_700_000_000_000)
  push('局号与游戏状态读得出来（状态保留 GSI 原值）', snap.matchid === '7600111222' && snap.gameState === 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', String(snap.gameState))
  push('比赛时间与昼夜', snap.clockTime === 183 && snap.daytime === true)
  push('英雄名/等级/存活', snap.hero.name === 'npc_dota_hero_nevermore' && snap.hero.level === 7 && snap.hero.alive === true)
  push('活着时没有复活倒计时', snap.hero.respawnIn === null)
  push('钱与战绩', snap.gold === 1200 && snap.score.kills === 3 && snap.score.deaths === 1 && snap.score.assists === 5)
  push('技能只留名字与等级（不带冷却）', snap.abilities.every((a) => Object.keys(a).sort().join(',') === 'level,name'), JSON.stringify(snap.abilities[0]))
  push('0 级技能不进列表', snap.abilities.length === 3 && !snap.abilities.some((a) => a.name === 'nevermore_presence'))
  push('技能按等级降序', snap.abilities.map((a) => a.level).join(',') === '4,2,1', snap.abilities.map((a) => a.level).join(','))
  push('空格子不算装备', snap.items.length === 1 && snap.items[0].name === 'item_blink')
  push('缺 id 的装备也留着（名字才是给人看的）', snapshotOf({ items: { slot0: { name: 'item_tango' } } }).items[0].id === null)
  push('一行摘要读得懂', snapshotLine(snap) === '3:03 · 白天 · npc_dota_hero_nevermore Lv7 · 1200 金 · 3/1/5 · 技能 3 · 装备 1', snapshotLine(snap))

  const dead = snapshotOf({ ...fullFrame, hero: { ...fullFrame.hero, alive: false, respawn_seconds: 24 } })
  push('死了才有复活倒计时', dead.hero.alive === false && dead.hero.respawnIn === 24)

  const bare = snapshotOf({ map: { clock_time: 12 } })
  push('只有 map 块时其余全是 null', bare.matchid === null && bare.hero.name === null && bare.gold === null && bare.abilities.length === 0)
  push('没有 hero 时钱是 null 而不是 0', bare.gold === null && bare.score.kills === null)
  push('空 payload 也不炸', snapshotLine(emptySnapshot()) === '这一帧没有可读的字段')

  const missingBlocks = snapshotOf({ map: { matchid: '1', clock_time: 5 } })
  push(
    '缺 hero/items/abilities 不触发断流告警（断流只看帧）',
    judgeGsiStall({ live: true, lastAt: 1_000, now: 1_500 }).state === 'fresh' &&
      judgeGsiStall({ live: true, lastAt: 1_000, now: 1_500, stallMs: 60_000 }).silentMs !== null &&
      missingBlocks.abilities.length === 0
  )

  resetSnapshot()
  const live = noteSnapshot(fullFrame, 1_700_000_001_000)
  push('内存里就是刚喂进去那一帧', currentSnapshot().matchid === live.matchid && currentSnapshot().clockTime === 183)
  push('摘要落在 logs 目录下（探针里是临时目录）', matchSnapshotPath() === join(logsDir(), 'match-snapshot.json'), matchSnapshotPath())
  push('落盘内容里没有冷却字段', !JSON.stringify(currentSnapshot()).includes('cooldown'))
  resetSnapshot()

  finishProbe('MATCH_SNAPSHOT_PROBE', cases, { line: snapshotLine(snap), abilities: snap.abilities.length, items: snap.items.length })
}
