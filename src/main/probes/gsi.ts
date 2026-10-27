import { app } from 'electron'
import { request } from 'node:http'
import {
  decideGsi,
  gsiStatus,
  shouldStopCaptureOnMatchEnd,
  startGsi,
  stopGsi,
  type GsiEffects,
  type GsiPayload
} from '../services/gsi'
import { cfgBody } from '../services/gsi-config'

/** 直接打本地端口：绕开全局 fetch（它被代理感知层换过，localhost 不该走代理）。 */
function post(port: number, payload: unknown): Promise<number> {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload)
    const req = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) }
      },
      (res) => {
        res.resume()
        res.on('end', () => resolve(res.statusCode ?? 0))
      }
    )
    req.on('error', reject)
    req.end(body)
  })
}

function get(port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const req = request({ host: '127.0.0.1', port, method: 'GET', path: '/' }, (res) => {
      res.resume()
      res.on('end', () => resolve(res.statusCode ?? 0))
    })
    req.on('error', reject)
    req.end()
  })
}

/**
 * GSI 探针（--gsi-probe）：不需要开游戏。
 * 先验纯判定（各种 game_state 的翻转语义），再用真实 HTTP 推一串 payload 走完整链路，
 * 断言「一局只开一次、打完只停一次、昵称只记一条」。
 */
export async function runGsiProbe(): Promise<void> {
  const events: { starts: number; stops: number; nicknames: string[]; pushed: string[] } = {
    starts: 0,
    stops: 0,
    nicknames: [],
    pushed: []
  }
  const ownLines: string[] = []
  const effects: GsiEffects = {
    startCapture: () => {
      events.starts += 1
    },
    stopCapture: () => {
      events.stops += 1
      return true
    },
    rememberNickname: (name) => {
      if (!events.nicknames.includes(name)) events.nicknames.push(name)
    },
    pushChat: (messages) => {
      // 自己发的行会带上 own：朗读要据此跳过，探针也顺带把它记下来断言。
      ownLines.push(...messages.filter((line) => line.own).map((line) => line.text))
      events.pushed.push(...messages.map((line) => line.text))
    }
  }

  // 纯判定：翻转语义 + 缺字段不误判。
  const decideCases: { name: string; got: string; want: string }[] = []
  const check = (name: string, prev: boolean, payload: GsiPayload, want: string): void => {
    decideCases.push({ name, got: decideGsi(prev, payload).drive, want })
  }
  const state = (gameState: string): GsiPayload => ({ map: { game_state: gameState, matchid: '42' } })
  check('菜单（没有 map）', false, { provider: { name: 'Dota 2' } }, 'none')
  check('菜单（没有 map）但上一帧在打', true, { provider: { name: 'Dota 2' } }, 'stop')
  check('选人阶段不开', false, state('DOTA_GAMERULES_STATE_HERO_SELECTION'), 'none')
  check('策略阶段不开', false, state('DOTA_GAMERULES_STATE_STRATEGY_TIME'), 'none')
  check('进对局开', false, state('DOTA_GAMERULES_STATE_PRE_GAME'), 'start')
  check('对局中已开，不重复开', true, state('DOTA_GAMERULES_STATE_GAME_IN_PROGRESS'), 'none')
  check('打完停', true, state('DOTA_GAMERULES_STATE_POST_GAME'), 'stop')
  check('没开着时打完不乱停', false, state('DOTA_GAMERULES_STATE_POST_GAME'), 'none')
  check('掉线停', true, state('DOTA_GAMERULES_STATE_DISCONNECT'), 'stop')
  const matchIdPicked = decideGsi(false, state('DOTA_GAMERULES_STATE_PRE_GAME')).matchId === '42'
  // cfg 形状：每一项都必须是「真 tab + 引号键」。九行写成字面 `\t` 时 Dota 只看到无意义 token，
  // 配置看着齐全、实际 abilities/items/draft/minimap 一个都没请求——这种坏法肉眼读 cfg 看不出来。
  const cfg = cfgBody(32123)
  const cfgKeys = [
    'provider',
    'map',
    'player',
    'events',
    'allplayers',
    'hero',
    'auth',
    'abilities',
    'items',
    'league',
    'draft',
    'wearables',
    'buildings',
    'minimap',
    'roshan',
    'couriers',
    'neutralitems',
    'previously',
    'added'
  ]
  const cfgMissing = cfgKeys.filter((key) => !cfg.includes(`\t\t"${key}"\t`)).concat(cfg.includes('\\') ? ['literal-backslash'] : [])
  const cfgOk = cfgMissing.length === 0

  // 真实 HTTP 链路：端口给 0 让系统分配，探针不去碰 Dota 目录。
  const started = await startGsi({ port: 0, effects, writeConfig: false })
  const port = started.port
  const statuses: number[] = []
  statuses.push(await get(port))
  statuses.push(await post(port, { provider: { name: 'Dota 2' }, map: { game_state: 'DOTA_GAMERULES_STATE_INIT' } }))
  statuses.push(await post(port, { provider: { name: 'Dota 2' }, map: { game_state: 'DOTA_GAMERULES_STATE_HERO_SELECTION' } }))
  statuses.push(
    await post(port, {
      provider: { name: 'Dota 2' },
      map: { game_state: 'DOTA_GAMERULES_STATE_PRE_GAME', matchid: '7771' },
      player: { name: 'Mystery' }
    })
  )
  const afterStart = gsiStatus()
  statuses.push(
    await post(port, {
      provider: { name: 'Dota 2' },
      map: { game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', matchid: '7771', game_time: 61 },
      player: { name: 'Mystery' }
    })
  )
  const during = gsiStatus()
  // 聊天正文：slot 先用 allplayers 翻成昵称再上屏；同一条重复推送只算一次。
  const chatFrame = {
    provider: { name: 'Dota 2' },
    map: { game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', matchid: '7771', game_time: 70 },
    player: { name: 'Mystery', player_slot: 0, team_name: 'radiant' },
    hero: { id: 11, name: 'npc_dota_hero_nevermore' },
    allplayers: {
      '0': { name: 'Mystery', team: 2, hero: 'npc_dota_hero_nevermore' },
      '1': { name: '队友A', team: 2, hero: 'npc_dota_hero_lina' },
      '7': { name: '敌人B', team: 3, hero: 'npc_dota_hero_pudge' }
    },
    events: [
      { event_type: 'chat_message', game_time: 70, player_id: 1, channel_type: 12, message: '别送我' },
      { event_type: 'chat_message', game_time: 71, player_id: 0, channel_type: 12, message: 'ok' },
      { event_type: 'chat_message', game_time: 72, player_id: 7, channel_type: 11, message: 'lol' }
    ]
  }
  statuses.push(await post(port, chatFrame))
  statuses.push(await post(port, chatFrame))
  // 座位空间回归（2026-10-25 正式局 9061601260 实测）：player_slot=1（lobby 加入序）
  // 而 team_slot=0（记分板座位）。own 必须跟 team_slot 对齐：player_id 0 才是自己、
  // player_id 1 是队友——旧代码用 player_slot 判 own 时这里会正好反过来。
  const seatFrame = {
    provider: { name: 'Dota 2' },
    map: { game_state: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS', matchid: '7771', game_time: 80 },
    player: { name: 'Mystery', player_slot: 1, team_slot: 0, team_name: 'radiant' },
    hero: { id: 11, name: 'npc_dota_hero_nevermore' },
    events: [
      { event_type: 'chat_message', game_time: 80, player_id: 0, channel_type: 12, message: 'me line' },
      { event_type: 'chat_message', game_time: 81, player_id: 1, channel_type: 12, message: 'mate line' }
    ]
  }
  statuses.push(await post(port, seatFrame))
  // 阵容：allplayers 三个人，我方在前，敌方在后；英雄名要削掉 npc_dota_hero_ 前缀。
  const duringChat = gsiStatus()
  statuses.push(
    await post(port, {
      provider: { name: 'Dota 2' },
      map: { game_state: 'DOTA_GAMERULES_STATE_POST_GAME', matchid: '7771' },
      player: { name: 'Mystery' }
    })
  )
  const afterPostGame = gsiStatus()

  // 下一局要能重新拉起：局末停掉只是这一局结束，不是永久停。
  statuses.push(
    await post(port, {
      provider: { name: 'Dota 2' },
      map: { game_state: 'DOTA_GAMERULES_STATE_PRE_GAME', matchid: '7772' },
      player: { name: 'Mystery' }
    })
  )
  const second = gsiStatus()
  // 坏包不该把服务打挂。
  statuses.push(await post(port, 'not-an-object-but-json'))
  stopGsi()
  const afterStop = gsiStatus()

  const failed = decideCases.filter((item) => item.got !== item.want)
  // 上屏的行必须带昵称，且重复推送只落一次（同一帧推了两遍，只该出三条）。
  // 行格式：[英雄] [关系] [昵称] 频道符号 正文。频道 12 = ⚔，11 = 🌐。
  const chatWant = [
    '[lina] [队友] [队友A] ⚔ 别送我',
    '[nevermore] [我] [Mystery] ⚔ ok',
    '[pudge] [敌方] [敌人B] 🌐 lol',
    // seatFrame：player_id 0 = 自己（team_slot），带英雄名；player_id 1 = 队友。
    '[nevermore] [我] [Mystery] ⚔ me line',
    '[lina] [队友] [队友A] ⚔ mate line'
  ]
  const chatOk =
    events.pushed.length === chatWant.length && chatWant.every((line) => events.pushed.includes(line))
  // 局末停捕获只对自动模式生效，手动模式的开关留给用户。
  const modeRuleOk = shouldStopCaptureOnMatchEnd('auto') && !shouldStopCaptureOnMatchEnd('manual')
  // 阵容与清理：局末清缓存后名单必须变空，否则下一局会看到上局的英雄。
  // 自己发的行必须带 own：朗读靠这个标记跳过，漏了就变成「念自己的话」。
  const ownOk = ownLines.length === 2 && ownLines.every((line) => line.includes('[我]'))
  const rosterOk =
    duringChat.roster.length === 3 &&
    duringChat.roster[0].slot === 0 &&
    duringChat.roster[0].side === 'mine' &&
    duringChat.roster[0].hero === 'nevermore' &&
    duringChat.roster[1].hero === 'lina' &&
    duringChat.roster[2].side === 'enemy' &&
    duringChat.rosterText === '我方 2 · 敌方 1 · 英雄 3/3' &&
    afterPostGame.roster.length === 0
  const ok =
    failed.length === 0 &&
    modeRuleOk &&
    rosterOk &&
    ownOk &&
    chatOk &&
    cfgOk &&
    matchIdPicked &&
    events.starts === 2 &&
    events.stops === 2 &&
    events.nicknames.length === 1 &&
    events.nicknames[0] === 'Mystery' &&
    afterStart.gameState === 'DOTA_GAMERULES_STATE_PRE_GAME' &&
    during.gameState === 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS' &&
    afterPostGame.gameState === 'DOTA_GAMERULES_STATE_POST_GAME' &&
    afterPostGame.autoStarts === 1 &&
    afterPostGame.autoStops === 1 &&
    second.autoStarts === 2 &&
    second.matchId === '7772' &&
    statuses.every((code) => code === 200) &&
    afterStop.listening === false

  console.log(
    'GSI_PROBE',
    JSON.stringify({
      ok,
      port,
      decideCases: decideCases.map((item) => ({ name: item.name, got: item.got, want: item.want })),
      cfgOk,
      cfgMissing,
      matchIdPicked,
      chatOk,
      rosterOk,
      ownOk,
      roster: duringChat.roster,
      rosterText: duringChat.rosterText,
      events,
      statuses,
      afterStart: { gameState: afterStart.gameState, matchId: afterStart.matchId, autoStarts: afterStart.autoStarts },
      during: { gameState: during.gameState },
      afterPostGame: {
        gameState: afterPostGame.gameState,
        autoStarts: afterPostGame.autoStarts,
        autoStops: afterPostGame.autoStops
      },
      second: { gameState: second.gameState, matchId: second.matchId, autoStarts: second.autoStarts },
      listeningAfterStop: afterStop.listening
    })
  )
  app.exit(ok ? 0 : 1)
}
