import { createServer, type IncomingMessage, type Server } from 'node:http'
import { join } from 'node:path'
import { app } from 'electron'
import { getCaptureService } from './capture/capturer'
import { loadSettings, saveSettings } from './settings'
import { appendCappedJsonl } from './logs/jsonl'
import { ensureGsiConfig, type GsiConfigResult } from './gsi-config'
import { flushFrameSummary, recordFrameSummary } from './gsi-frames-summary'
import type { GsiStatusView } from '../../shared/ipc'
import { buildRoster, rosterLine } from './team-intel'
import type { ChatLine } from '@shared/chat-line'

/**
 * Dota 2 Game State Integration：Valve 官方支持的本地状态推送。
 *
 * 捕获循环只能看到屏幕，回答不了「现在到底在不在对局里」——聊天区没人说话和不在游戏里，
 * 在 OCR 眼里是同一张图。GSI 直接把 `map.game_state` 推过来，于是进对局能自动开捕获、
 * 打完了能自动停，顺带把 `player.name` 填进 myNicknames（自己说的话不该被翻译）。
 *
 * 正文还能从 GSI 拿：cfg 的 data 里开了 `"events" "1"`，Dota 就会把对局内聊天塞进
 * `payload.events[]`，形如 `{ event_type: 'chat_message', player_id, channel_type, message }`
 * （channel_type 11 = 所有人，12 = 队伍）。所以正文有两条并列的路：`ocr` 抓屏识别，`gsi` 走这里。
 * 聊天事件只带说话人 slot、不带昵称，昵称靠 `"allplayers" "1"`
 * 推来的表把 slot 翻成名字；实在没有就退回「我 / 玩家N」，绝不因为缺名字丢消息。
 */
export const GSI_PORT = 32123
/** cfg 里写的是 heartbeat 30 s，留三倍余量：Dota 崩了/关了才判「游戏没了」。 */
const HEARTBEAT_TIMEOUT_MS = 90_000

/** 只有这两个状态代表「正在打」，选人/策略阶段不启动，避免白烧 OCR。 */
const LIVE_STATES = new Set(['DOTA_GAMERULES_STATE_PRE_GAME', 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS'])
/** 打完和掉线：立刻停，最后的几句话在这之前已经抓过了。 */
const TERMINAL_STATES = new Set(['DOTA_GAMERULES_STATE_POST_GAME', 'DOTA_GAMERULES_STATE_DISCONNECT'])

/** `events[]` 的一条。每条只带自己那种事件需要的字段，所以除 event_type 外全可选。 */
export interface GsiEvent {
  game_time?: number
  event_type?: string
  /** chat_message：说话人的 slot，与自己 player.player_slot 比即可判断是不是自己说的。 */
  player_id?: number
  /** chat_message：11 = 所有人，12 = 队伍（13 观战 / 14 教练）。 */
  channel_type?: number
  /** chat_message：正文。 */
  message?: string
}

/** 验证期证据文件：chat_message 原样落盘，方便和屏幕上那一行逐字对账。 */
export function gsiChatLogPath(): string {
  return join(app.getPath('userData'), 'logs', 'gsi-chat.jsonl')
}

const CHAT_LOG_MAX_BYTES = 256_000

function recordChatEvent(
  event: GsiEvent,
  mySlot: number | undefined,
  label: string,
  hero: string,
  relation: string
): void {
  const slot = event.player_id
  const record = {
    at: new Date().toISOString(),
    channel: event.channel_type ?? null,
    slot: slot ?? null,
    name: label,
    own: slot !== undefined && slotIsSelf(slot, mySlot),
    // 英雄/关系当时拿没拿到，直接记进证据文件——「这句为什么没带英雄名」从 jsonl 就能答。
    hero: hero || null,
    relation,
    gameTime: event.game_time ?? null,
    text: typeof event.message === 'string' ? event.message : null
  }
  appendCappedJsonl(gsiChatLogPath(), record, CHAT_LOG_MAX_BYTES)
}

/**
 * player 块证据（logs/gsi-player.jsonl）：name/player_slot/team_slot/steamid 每变化落一行。
 * 2026-10-25 正式局 own 误判（slot 3 是 lion 却被判成自己，OpenDota 交叉验证坐实）暴露
 * player_slot 语义未定；console.log 的 PlayerResource 行显示 lobby slot / PlayerID / team slot
 * 是三个不同空间，bot 局三者重合所以从未露馅。有这份留痕，下一局就能定死 GSI 的
 * player_slot 到底是哪个空间、own 判定该用哪个字段。
 */
const PLAYER_LOG_MAX_BYTES = 64_000
let lastPlayerLine = ''
function recordPlayer(payload: GsiPayload): void {
  const p = payload.player
  if (!p) return
  const fields = {
    matchId: payload.map?.matchid ?? null,
    gameState: payload.map?.game_state ?? null,
    name: p.name ?? null,
    playerSlot: p.player_slot ?? null,
    teamSlot: p.team_slot ?? null,
    teamName: p.team_name ?? null,
    steamid: p.steamid ?? null
  }
  // 去重键不含 at：player 块内容不变就不落行，否则每帧一条把留痕刷成流水账。
  const key = JSON.stringify(fields)
  if (key === lastPlayerLine) return
  lastPlayerLine = key
  appendCappedJsonl(join(app.getPath('userData'), 'logs', 'gsi-player.jsonl'), { at: new Date().toISOString(), ...fields }, PLAYER_LOG_MAX_BYTES)
}

/**
 * draft 块证据（logs/gsi-draft.jsonl）：唯一还没验证的「slot→英雄」候选来源。
 * allplayers 真对局不推（三次实测 0 帧）、minimap 元素不带玩家槽位（试炼场+真局 dump 均确认），
 * 剩下的可能只有选人阶段的 draft。它只在 HERO_SELECTION 附近有内容、且同内容连推几十帧，
 * 所以去重后落盘、封顶 256 KB——打完一局直接读文件就能判「给不给、键长什么样」。
 */
const DRAFT_LOG_MAX_BYTES = 256_000
const SEEN_DRAFT_MAX = 64
const seenDraft = new Set<string>()

function recordDraft(payload: GsiPayload): void {
  const draft = payload.draft
  if (!draft || typeof draft !== 'object' || Object.keys(draft).length === 0) return
  const record = {
    at: new Date().toISOString(),
    matchId: payload.map?.matchid ?? null,
    gameState: payload.map?.game_state ?? null,
    draft
  }
  const line = JSON.stringify(record)
  boundedRemember(seenDraft, line, SEEN_DRAFT_MAX)
  appendCappedJsonl(join(app.getPath('userData'), 'logs', 'gsi-draft.jsonl'), record, DRAFT_LOG_MAX_BYTES)
}

/** 一帧里的聊天事件都落盘；自己说的那几条用 own 标出来，对账时好区分。 */
/** 有界去重集合：塞进第 max+1 条时淘汰最早的一条（Map/Set 都按插入序，语义一致）。 */
function boundedRemember(store: Set<string>, key: string, max: number): void {
  if (store.has(key)) return
  store.add(key)
  if (store.size > max)
    for (const oldest of store.keys()) {
      store.delete(oldest)
      break
    }
}
const SEEN_CHAT_MAX = 256
const seenChatEvents = new Set<string>()

function chatEventKey(event: GsiEvent, slot: number | undefined): string {
  return [event.game_time ?? '', event.player_id ?? '', event.channel_type ?? '', slot ?? '', event.message ?? ''].join('|')
}

/**
 * slot → 昵称。`chat_message` 只给 `player_id`（slot），昵称要另外开 cfg 的 `allplayers` 才有，
 * 所以这里按帧刷新缓存：有名字就记，没名字就退回「我 / 玩家N」，绝不因为缺名字丢消息。
 */
const slotNames = new Map<number, string>()
/** slot → 英雄。allplayers 里带 `hero`；自己那份 allplayers 里没有，要 cfg 开 `"hero" "1"`。 */
const slotHeroes = new Map<number, string>()
/** slot → 阵营，用来分辨「队友」和「敌方」：allplayers 给数字 2/3，自己的那份给 team_name。 */
const slotTeams = new Map<number, string>()
/** 自己那份不在 allplayers 里：槽位和阵营单独记，拼阵容要靠它分辨「我方」。 */
let mySlotCache: number | undefined
let myTeamCache = ''

/** `npc_dota_hero_nevermore` → `nevermore`：前面那截每个英雄都一样，留着只是噪声。 */
function heroShort(raw: string | undefined): string {
  if (typeof raw !== 'string') return ''
  return raw.trim().replace(/^npc_dota_hero_/, '')
}

function rememberSide(slot: number, info: { hero?: string; team?: number } | undefined): void {
  if (!Number.isFinite(slot)) return
  const hero = heroShort(info?.hero)
  if (hero.length > 0) slotHeroes.set(slot, hero)
  const team = info?.team === 2 ? 'radiant' : info?.team === 3 ? 'dire' : ''
  if (team.length > 0) slotTeams.set(slot, team)
}

function refreshSlotNames(payload: GsiPayload): void {
  const all = payload.allplayers
  if (all && typeof all === 'object')
    for (const [key, info] of Object.entries(all)) {
      const slot = Number(key)
      const name = typeof info?.name === 'string' ? info.name.trim() : ''
      if (Number.isFinite(slot) && name.length > 0) slotNames.set(slot, name)
      rememberSide(slot, info)
    }
  const self = payload.player
  const selfName = typeof self?.name === 'string' ? self.name.trim() : ''
  // 自己的座位用 team_slot（记分板座位），不用 player_slot：2026-10-25 两局实测坐实
  // player_slot 是 lobby 加入序、team_slot 才是座位——正式局 9061601260 里两者当场分家
  // （playerSlot 1 vs teamSlot 2），而聊天事件 player_id 用的是座位空间（9061521387 里
  // lion 的 ggwp 带 player_id 3 = lion 的座位，OpenDota 对得上）。用 player_slot 判 own
  // 会把「加入序恰好等于我座位号」的那个队友的话算成我的。
  const selfSeat =
    typeof self?.team_slot === 'number'
      ? self.team_slot
      : typeof self?.player_slot === 'number'
        ? self.player_slot
        : undefined
  if (selfName.length > 0 && selfSeat !== undefined) slotNames.set(selfSeat, selfName)
  if (selfSeat !== undefined) mySlotCache = selfSeat
  if (typeof self?.team_name === 'string' && self.team_name.trim().length > 0) myTeamCache = self.team_name.trim()
  if (selfSeat !== undefined) rememberSide(selfSeat, { hero: payload.hero?.name })
}

/** 天辉 0–4 / 夜魇 128–132，同一个槽位两种写法都要能对上。 */
function slotIsSelf(slot: number, mySlot: number | undefined): boolean {
  if (mySlot === undefined) return false
  return slot === mySlot || slot % 128 === mySlot % 128
}

function slotLabel(slot: number | undefined, mySlot: number | undefined): string {
  if (slot === undefined) return '未知'
  const name = slotNames.get(slot) ?? slotNames.get(slot % 128) ?? slotNames.get(slot + 128)
  if (name) return name
  return slotIsSelf(slot, mySlot) ? '我' : `玩家${(slot % 128) + 1}`
}


function slotHero(slot: number | undefined): string {
  if (slot === undefined) return ''
  return slotHeroes.get(slot) ?? slotHeroes.get(slot % 128) ?? slotHeroes.get(slot + 128) ?? ''
}

/** 说话人相对我：我 / 队友 / 敌方；阵营没拿到就老实用「玩家」，别猜。 */
function slotRelation(
  slot: number | undefined,
  mySlot: number | undefined,
  myTeam: string,
  channel: number | undefined
): string {
  if (slot === undefined) return '未知'
  if (slotIsSelf(slot, mySlot)) return '我'
  const team = slotTeams.get(slot) ?? slotTeams.get(slot % 128) ?? slotTeams.get(slot + 128)
  if (team && myTeam) return team === myTeam ? '队友' : '敌方'
  return channel === 12 ? '队友' : '玩家'
}


function recordChatEvents(payload: GsiPayload): ChatLine[] {
  const events = payload.events
  if (!Array.isArray(events)) return []
  // player 块不保证每帧都来（GSI 各数据块独立推送，带聊天事件的帧常常只有 events）：
  // 当帧没有就用上一帧缓存的槽位/阵营，own 判定才不会把自己的话判成别人
  // （真对局 2026-10-25 第四局实测：slot 8 名字缓存正确、own 却是 false，就是这帧缺 player 块）。
  // 座位取 team_slot（聊天 player_id 是座位空间，见 refreshSlotNames 的注释）；
  // player_slot 是 lobby 加入序，用它判 own 会张冠李戴。
  const mySlot = payload.player?.team_slot ?? payload.player?.player_slot ?? mySlotCache
  const myTeam =
    typeof payload.player?.team_name === 'string'
      ? payload.player.team_name.trim().toLowerCase()
      : myTeamCache.trim().toLowerCase()
  const accepted: ChatLine[] = []
  for (const event of events) {
    if (event?.event_type !== 'chat_message') continue
    const key = chatEventKey(event, mySlot)
    if (seenChatEvents.has(key)) continue
    boundedRemember(seenChatEvents, key, SEEN_CHAT_MAX)
    const label = slotLabel(event.player_id, mySlot)
    // 英雄/关系在行组装前先算好：落盘记录里带上它们，对账时一眼看出这条当时有没有英雄名。
    const hero = slotHero(event.player_id)
    const relation = slotRelation(event.player_id, mySlot, myTeam, event.channel_type)
    recordChatEvent(event, mySlot, label, hero, relation)
    // 只组装值：展示串由 renderChatLine 拼、正文就是 event.message，下游不再拆回来。
    if (typeof event.message === 'string' && event.message.trim())
      accepted.push({
        ...(hero ? { hero } : {}),
        relation,
        speaker: label,
        channel: event.channel_type === 11 ? 'all' : 'team',
        body: event.message.trim(),
        own: event.player_id !== undefined && slotIsSelf(event.player_id, mySlot)
      })
  }
  return accepted
}
export interface GsiPayload {
  provider?: { name?: string; appid?: number }
  map?: {
    name?: string
    game_state?: string
    matchid?: string
    game_time?: number
    win_team?: string
  }
  /**
   * player 块。注意 `player_slot` 与 `team_slot` 是两个字段：2026-10-25 正式局 own 误判
   * （slot 3 是 lion 却被判成自己，OpenDota 交叉验证坐实）说明 player_slot 可能是
   * lobby 加载序而非队伍座位，语义未定，见 recordPlayer 的留痕。
   */
  player?: {
    name?: string
    team_name?: string
    player_slot?: number
    team_slot?: number
    steamid?: string
  }
  /** cfg 开了 `"events" "1"` 才有：每条只带自己那种事件需要的字段。 */
  events?: GsiEvent[]
  /** cfg 开了 `"allplayers" "1"` 才有：key 是 slot，拿来把聊天事件里的 player_id 翻成昵称。 */
  allplayers?: Record<string, { name?: string; team?: number; hero?: string; hero_id?: number }>
  /** cfg 开了 `"hero" "1"` 才有：自己的英雄（自己那份在 allplayers 里查不到）。 */
  hero?: { id?: number; name?: string }
  /** cfg 开了 `"draft" "1"` 才有：选人阶段的 BP 数据。是否带 slot→英雄映射未验证，见 recordDraft。 */
  draft?: Record<string, unknown>
}

export interface GsiDrive {
  /** 这一帧是否代表「正在打」。 */
  live: boolean
  /** 需要对捕获做什么。只在状态翻转的那一帧非 none。 */
  drive: 'start' | 'stop' | 'none'
  gameState: string | null
  matchId: string | null
}

/**
 * 纯判定：从「上一帧是否在打」和这一帧的 payload 得出要不要开/停捕获。
 * 只认翻转，所以用户中途手动停掉捕获之后不会被下一帧心跳又拉起来。
 */

export function decideGsi(prevLive: boolean, payload: GsiPayload): GsiDrive {
  const state = payload.map?.game_state ?? null
  const matchId = payload.map?.matchid ?? null
  if (state !== null && TERMINAL_STATES.has(state)) {
    return { live: false, drive: prevLive ? 'stop' : 'none', gameState: state, matchId }
  }
  const live = state !== null && LIVE_STATES.has(state)
  if (live && !prevLive) return { live: true, drive: 'start', gameState: state, matchId }
  if (!live && prevLive) return { live: false, drive: 'stop', gameState: state, matchId }
  return { live, drive: 'none', gameState: state, matchId }
}

/** 形状定义在 shared 里：渲染进程的面板要读同一份。 */
export type GsiStatus = GsiStatusView

interface GsiRuntime {
  server: Server | null
  live: boolean
  startedByGsi: boolean
  gameState: string | null
  matchId: string | null
  lastAt: number | null
  autoStarts: number
  autoStops: number
  config: GsiConfigResult | null
  watchdog: ReturnType<typeof setInterval> | null
  port: number
}

const runtime: GsiRuntime = {
  server: null,
  live: false,
  startedByGsi: false,
  gameState: null,
  matchId: null,
  lastAt: null,
  autoStarts: 0,
  autoStops: 0,
  config: null,
  watchdog: null,
  port: GSI_PORT
}

/** 从三张缓存拼出阵容：槽位取三者的并集，缺什么就留空，不编造。 */
function rosterView(): { roster: GsiStatusView['roster']; rosterText: string } {
  const slots = new Set<number>([...slotNames.keys(), ...slotHeroes.keys(), ...slotTeams.keys()])
  const players = [...slots].map((slot) => ({
    slot,
    name: slotNames.get(slot),
    hero: slotHeroes.get(slot),
    team: slotTeams.get(slot)
  }))
  const roster = buildRoster(players, mySlotCache, myTeamCache)
  return { roster, rosterText: rosterLine(roster) }
}

export function gsiStatus(): GsiStatus {
  return {
    listening: runtime.server !== null,
    port: runtime.port,
    gameState: runtime.gameState,
    matchId: runtime.matchId,
    lastAt: runtime.lastAt,
    autoStarts: runtime.autoStarts,
    autoStops: runtime.autoStops,
    configPath: runtime.config?.path ?? null,
    configError: runtime.config?.error ?? null,
    ...rosterView()
  }
}

/** 侧效应边界：探针注入假的实现，就不必真的去开关捕获。 */
export interface GsiEffects {
  startCapture(): void | Promise<void>
  /** 一局结束：停捕获，并把这一局的账本清干净。返回是否真的停了。 */
  endMatch(): boolean | Promise<boolean>
  rememberNickname(name: string): void
  /** 把去重后的聊天正文交给捕获服务。这里的去重只管 GSI 一次事件推 26 遍那件事。 */
  pushChat(messages: ChatLine[]): void
}

function defaultEffects(): GsiEffects {
  return {
    startCapture: () => {
      // 尊重「启动时自动开始捕获」这个总开关：关掉它的人不希望 GSI 替他开。
      if (!loadSettings().autoStartCapture) return
      getCaptureService().start()
    },
    endMatch: () => {
      const capture = getCaptureService()
      capture.stop()
      // 局末是明确信号：顺手清屏，别让上一局的话挂到下一局去。
      capture.endMatchSession()
      return true
    },
    rememberNickname: (name) => {
      const settings = loadSettings()
      if (settings.myNicknames.includes(name)) return
      saveSettings({ myNicknames: [...settings.myNicknames, name].slice(-8) })
    },
    pushChat: (messages) => {
      // 不再看模式：手动模式是「抓屏拍一张照」的语义，GSI 正文根本没有快照这回事；
      // 以前要求自动模式，用户一换正文来源，推送就被静默吞掉。
      getCaptureService().pushMessages(messages)
    }
  }
}

function readBody(req: IncomingMessage, limitBytes = 256 * 1024): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > limitBytes) {
        reject(new Error('GSI payload 过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

/** 停捕获可能是异步的：只在它真的停了之后才记一次 autoStops。 */
function countStop(result: boolean | Promise<boolean>): void {
  if (result === true) {
    runtime.autoStops += 1
    return
  }
  if (result instanceof Promise) {
    void result.then(
      (stopped) => {
        if (stopped) runtime.autoStops += 1
      },
      () => undefined
    )
  }
}

/**
 * 一局结束的共同收场：停捕获、清账本、落小结。
 * POST_GAME 和心跳超时是同一件事的两条入口，次序写两遍就一定会漏：漏掉清账本，
 * 上一局的话会挂到下一局；漏掉小结，这一局就没有可复盘的文件。
 */
function closeMatch(effects: GsiEffects): void {
  runtime.startedByGsi = false
  countStop(effects.endMatch())
  // 局末立刻落一次小结：这是唯一能复盘整局的时机。
  flushFrameSummary()
}

/** 处理一次推送。拆出来是为了让探针能直接喂 payload，不必绕 HTTP。 */
export function handleGsiPayload(payload: GsiPayload, effects: GsiEffects): GsiDrive {
  const decision = decideGsi(runtime.live, payload)
  runtime.live = decision.live
  // 脏包/不带 map 的帧只影响 live 判定，不该把上一次读到的对局状态抹掉。
  const prevMatchId = runtime.matchId
  if (decision.gameState !== null) {
    runtime.gameState = decision.gameState
    runtime.matchId = decision.matchId
  }
  runtime.lastAt = Date.now()
  // 每一帧都记进小结账本：真对局时不可能去抢 32123 端口，只能在应用里攒。
  recordFrameSummary(payload)
  recordDraft(payload)
  recordPlayer(payload)
  // 一局结束就清掉 slot→昵称：下一局同号位换人，缓存着旧名字会张冠李戴。
  // matchid 变了同样算「一局结束」：没等到 POST_GAME 就进下一局（秒排/重连）时，
  // 光靠 drive=stop 清不掉，旧名字和新号位对不上就是假情报。
  const matchIdChanged =
    decision.matchId !== null &&
    prevMatchId !== null &&
    decision.matchId !== prevMatchId
  if (decision.drive === 'stop' || matchIdChanged) {
    slotNames.clear()
    // 英雄/阵营也要一起清：下一局同一个槽位换了人和英雄，留着就是错的情报。
    slotHeroes.clear()
    slotTeams.clear()
    mySlotCache = undefined
    myTeamCache = ''
  }
  refreshSlotNames(payload)
  const nickname = payload.player?.name
  if (nickname && nickname.trim().length > 0) effects.rememberNickname(nickname.trim())
  const chat = recordChatEvents(payload)
  if (chat.length > 0) effects.pushChat(chat)
  if (decision.drive === 'start') {
    runtime.startedByGsi = true
    runtime.autoStarts += 1
    void effects.startCapture()
  } else if (decision.drive === 'stop') {
    closeMatch(effects)
  }
  return decision
}

/** 游戏关掉之后不会再有推送，也不能让捕获一直空转。 */
function armWatchdog(effects: GsiEffects): void {
  if (runtime.watchdog !== null) clearInterval(runtime.watchdog)
  runtime.watchdog = setInterval(() => {
    if (!runtime.live || runtime.lastAt === null) return
    if (Date.now() - runtime.lastAt < HEARTBEAT_TIMEOUT_MS) return
    runtime.live = false
    // 捕获不是 GSI 开的就别替用户停；是它开的，收场必须和 POST_GAME 走同一条路。
    if (!runtime.startedByGsi) return
    closeMatch(effects)
  }, 10_000)
}

export interface StartGsiOptions {
  port?: number
  effects?: GsiEffects
  /** 探针里关掉：不去动 Dota 目录、不写配置。 */
  writeConfig?: boolean
  /** 每一帧原始 payload：`--gsi-dump` 用它把「Dota 到底推了什么」摊开看。 */
  onFrame?: (payload: GsiPayload) => void
}

export async function startGsi(options: StartGsiOptions = {}): Promise<GsiStatus> {
  if (runtime.server !== null) return gsiStatus()
  const port = options.port ?? GSI_PORT
  const effects = options.effects ?? defaultEffects()
  const server = createServer((req, res) => {
    void (async () => {
      if (req.method !== 'POST') {
        res.writeHead(200).end('oh-my-dota2 gsi')
        return
      }
      let payload: GsiPayload = {}
      try {
        const body = await readBody(req)
        payload = body.length > 0 ? (JSON.parse(body) as GsiPayload) : {}
      } catch {
        res.writeHead(400).end()
        return
      }
      handleGsiPayload(payload, effects)
      options.onFrame?.(payload)
      // GSI 只关心 2xx，不回包体。
      res.writeHead(200).end()
    })()
  })
  // 端口被占（另一个实例还在退、或用户自己开了两次）不该让整个应用崩掉：
  // 聊天走 GSI 以外的功能都还能用，只是这局拿不到对局状态。记一行日志，监听保持 false。
  const listenError = await new Promise<NodeJS.ErrnoException | null>((resolve) => {
    server.once('error', (err: NodeJS.ErrnoException) => resolve(err))
    server.listen(port, '127.0.0.1', () => {
      server.removeAllListeners('error')
      resolve(null)
    })
  })
  if (listenError) {
    console.log('GSI_LISTEN_FAILED', JSON.stringify({ port, code: listenError.code ?? 'unknown' }))
    server.close()
    return gsiStatus()
  }
  const address = server.address()
  runtime.port = typeof address === 'object' && address !== null ? address.port : port
  runtime.server = server
  runtime.live = false
  runtime.startedByGsi = false
  runtime.lastAt = null
  armWatchdog(effects)
  if (options.writeConfig !== false) runtime.config = await ensureGsiConfig(runtime.port)
  return gsiStatus()
}

export function stopGsi(): void {
  if (runtime.watchdog !== null) clearInterval(runtime.watchdog)
  runtime.watchdog = null
  runtime.server?.close()
  runtime.server = null
  runtime.live = false
}
