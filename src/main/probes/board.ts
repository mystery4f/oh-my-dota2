/**
 * 副屏看板（#124a）的探针：一条 320 宽的条子怎么把快照读成六行字。
 *
 * 钉的是票面那三条里能自动验的两条——缺块写 `—`、没有快照就整条说实话；
 * 「关掉看板不动浮层」由代码结构保证（`windows/board.ts` 不 import 浮层管理器），
 * 探针这里只再断言一次：那个文件里没有 `getOverlayManager` 字样。
 */
import { boardView, clockText, heroText, aliveText, ageView, shortState, BOARD_FRESH_MS, BOARD_STALE_MS } from '@shared/board-view'
import { emptySnapshot, snapshotOf } from '@shared/match-snapshot'
import { finishProbe, probeCases } from './harness'

const NOW = Date.UTC(2026, 10, 21, 12, 0, 0)

export function runBoardProbe(): void {
  const { cases, push } = probeCases()

  push('状态标签：GSI 前缀换成短标签', shortState('DOTA_GAMERULES_STATE_GAME_IN_PROGRESS') === '对局中', shortState('DOTA_GAMERULES_STATE_GAME_IN_PROGRESS'))
  push('状态标签：选人', shortState('DOTA_GAMERULES_STATE_HERO_SELECTION') === '选人', shortState('DOTA_GAMERULES_STATE_HERO_SELECTION'))
  push('状态标签：认不出就保留原名（不编）', shortState('DOTA_GAMERULES_STATE_SOMETHING_NEW') === 'SOMETHING_NEW', shortState('DOTA_GAMERULES_STATE_SOMETHING_NEW'))
  push('状态标签：空值写 —', shortState(null) === '—', shortState(null))

  push('时间：正数是 M:SS', clockText(183) === '3:03', clockText(183))
  push('时间：负数是选人倒计时', clockText(-24) === '-0:24', clockText(-24))
  push('时间：空值写 —', clockText(null) === '—', clockText(null))

  push('存活：活着', aliveText(true, null).text === '活着', aliveText(true, null).text)
  push('存活：死了给复活秒数', aliveText(false, 12.4).text === '复活 12 s', aliveText(false, 12.4).text)
  push('存活：缺块写 —', aliveText(null, null).text === '—', aliveText(null, null).text)

  push('英雄：去前缀 + 等级', heroText('npc_dota_hero_nevermore', 7) === 'nevermore Lv7', heroText('npc_dota_hero_nevermore', 7))

  push('最后一帧：6 秒内算实时', ageView(NOW - 1200, NOW).tone === 'ok' && ageView(NOW - 1200, NOW).text === '1.2 秒前', ageView(NOW - 1200, NOW).text)
  push('最后一帧：超过 6 秒转黄', ageView(NOW - BOARD_FRESH_MS - 3000, NOW).tone === 'warn', ageView(NOW - 9000, NOW).text)
  push('最后一帧：超过 90 秒说早断了', ageView(NOW - BOARD_STALE_MS - 60_000, NOW).tone === 'bad' && ageView(NOW - BOARD_STALE_MS - 60_000, NOW).text.includes('早断了'), ageView(NOW - BOARD_STALE_MS - 60_000, NOW).text)

  const empty = boardView(null, NOW)
  push('没有快照：整条说实话，不排空壳', empty.empty && empty.rows.length === 0 && (empty.headline ?? '').includes('先把 GSI 那条连通'), empty.headline ?? '')

  const bare = boardView(emptySnapshot(NOW), NOW)
  // 空快照仍有时间戳（它是「刚送来的一帧，只是没有字段」），所以最后一帧那格如实报 0.0 秒前；
  // 数据五项一律写 —，不许把缺块猜成 Lv1 / 0 金。
  push(
    '空快照：五项写 —，最后一帧仍报时间',
    bare.rows.length === 6 &&
      bare.rows.filter((row) => row.key !== 'age').every((row) => row.value === '—') &&
      (bare.rows.find((row) => row.key === 'age')?.value ?? '').endsWith('秒前'),
    bare.rows.map((r) => r.value).join('|')
  )

  const full = boardView(
    snapshotOf(
      {
        map: { matchid: '7788', game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', clock_time: 183, daytime: true },
        hero: {
          name: 'npc_dota_hero_nevermore',
          level: 7,
          alive: false,
          respawn_seconds: 12,
          gold: 1200,
          kills: 3,
          deaths: 1,
          assists: 5
        },
        abilities: { ability_1: { name: 'ability_nevermore_shadowraze1', level: 2 } },
        items: { slot0: { name: 'item_boots' } }
      },
      NOW - 500
    ),
    NOW
  )
  const byKey = new Map(full.rows.map((row) => [row.key, row.value]))
  push('真快照：六项取值对得上', !full.empty && byKey.get('match') === '7788' && byKey.get('clock') === '3:03' && byKey.get('hero') === 'nevermore Lv7', [...byKey.values()].join('|'))
  push('真快照：死了给复活秒数', byKey.get('alive') === '复活 12 s', byKey.get('alive') ?? '')
  push('真快照：最后一帧 0.5 秒前', byKey.get('age') === '0.5 秒前', byKey.get('age') ?? '')

  // 「关掉看板不动浮层」的结构证据在源码里（`windows/board.ts` 没有 import 浮层管理器），
  // 打包后 main 是单文件、探针读不到子模块——这条靠代码走查，不在探针里假装能验。
  const stale = boardView(snapshotOf({ map: { matchid: '9', game_state: 'DOTA_GAMERULES_STATE_POST_GAME', clock_time: 60 } }, NOW - BOARD_STALE_MS - 60000), NOW)
  push('断流很久：最后一帧那格说早断了，其余照常显示', stale.rows.find((r) => r.key === 'age')?.tone === 'bad' && stale.rows.length === 6, stale.rows.find((r) => r.key === 'age')?.value ?? '')

  finishProbe('BOARD_PROBE', cases)
}
