/**
 * 副屏看板（#124a）的纯缝：一条 320 宽的长条，六项，全部来自 `matchSnapshot()`。
 *
 * 这里只放「怎么把一个快照读成六行字」的决定，窗口与轮询在主进程与渲染层各管一段。
 * 三条口径写死在测试里：缺块写 `—`（不许猜成 Lv1）、没有快照就整条说实话（不显示空壳）、
 * 比赛时间是负数时写成 `-0:24`（选人倒计时），不是 `0:-24`。
 */
import type { MatchSnapshot } from './match-snapshot'

/** 窗口宽度固定 320：原型定稿就是这个形状，不是第二个面板。 */
export const BOARD_WIDTH = 320
/** 一条的高度：六项排两列，一行一项半。 */
export const BOARD_HEIGHT = 120

/** 快照「还新不新」的两条阈值：6 秒内算实时，90 秒后算早就断了。 */
export const BOARD_FRESH_MS = 6_000
export const BOARD_STALE_MS = 90_000

export type BoardTone = 'ok' | 'warn' | 'bad' | 'dim'

export interface BoardRow {
  key: string
  label: string
  value: string
  tone: BoardTone
}

export interface BoardView {
  /** 没有快照时为 true：整条只显示一句人话，不排空壳。 */
  empty: boolean
  headline: string | null
  rows: BoardRow[]
}

const STATE_LABELS: Record<string, string> = {
  INIT: '启动',
  WAIT_FOR_PLAYERS_TO_LOAD: '加载',
  HERO_SELECTION: '选人',
  STRATEGY_TIME: '买装',
  PRE_GAME: '备战',
  GAME_IN_PROGRESS: '对局中',
  POST_GAME: '赛后'
}

/** `DOTA_GAMERULES_STATE_GAME_IN_PROGRESS` → `对局中`；认不出就保留原名，别编。 */
export function shortState(gameState: string | null): string {
  if (gameState === null || gameState === '') return '—'
  const bare = gameState.replace(/^DOTA_GAMERULES_STATE_/i, '')
  return STATE_LABELS[bare.toUpperCase()] ?? bare
}

/** 比赛时间：负数 = 选人倒计时（`-0:24`），正数是 `M:SS`。 */
export function clockText(clockTime: number | null): string {
  if (clockTime === null) return '—'
  const total = Math.abs(Math.trunc(clockTime))
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  const body = `${minutes}:${String(seconds).padStart(2, '0')}`
  return clockTime < 0 ? `-${body}` : body
}

/** 最后一帧多久前：三档阈值 + 一句「早断了」，别只给数字。 */
export function ageView(at: number | null, now: number): { text: string; tone: BoardTone } {
  if (at === null) return { text: '—', tone: 'dim' }
  const ms = Math.max(0, now - at)
  if (ms < BOARD_FRESH_MS) return { text: `${(ms / 1000).toFixed(1)} 秒前`, tone: 'ok' }
  if (ms < BOARD_STALE_MS) return { text: `${Math.round(ms / 1000)} 秒前`, tone: 'warn' }
  return { text: `${Math.round(ms / 60_000)} 分钟前 · 早断了`, tone: 'bad' }
}

/** 英雄名去掉 `npc_dota_hero_` 前缀；去不掉就原样（不猜本地化名）。 */
export function heroText(name: string | null, level: number | null): string {
  if (name === null || name === '') return '—'
  const bare = name.replace(/^npc_dota_hero_/i, '')
  return level === null ? bare : `${bare} Lv${level}`
}

/** 存活：活着写「活着」，死了写复活秒数。 */
export function aliveText(alive: boolean | null, respawnIn: number | null): { text: string; tone: BoardTone } {
  if (alive === null) return { text: '—', tone: 'dim' }
  if (alive) return { text: '活着', tone: 'ok' }
  return { text: respawnIn === null ? '已阵亡' : `复活 ${Math.max(0, Math.round(respawnIn))} s`, tone: 'bad' }
}

/** 六项 → 一份可以直接铺的视图。 */
export function boardView(snapshot: MatchSnapshot | null, now: number): BoardView {
  if (snapshot === null) {
    return {
      empty: true,
      headline: '没有快照：先把 GSI 那条连通（总览 → 对局正文）',
      rows: []
    }
  }
  const age = ageView(snapshot.at, now)
  const alive = aliveText(snapshot.hero?.alive ?? null, snapshot.hero?.respawnIn ?? null)
  return {
    empty: false,
    headline: null,
    rows: [
      { key: 'match', label: '局号', value: snapshot.matchid ?? '—', tone: 'dim' },
      { key: 'state', label: '状态', value: shortState(snapshot.gameState), tone: 'dim' },
      { key: 'clock', label: '时间', value: clockText(snapshot.clockTime), tone: 'dim' },
      { key: 'hero', label: '我玩', value: heroText(snapshot.hero?.name ?? null, snapshot.hero?.level ?? null), tone: 'dim' },
      { key: 'alive', label: '存活', value: alive.text, tone: alive.tone },
      { key: 'age', label: '最后一帧', value: age.text, tone: age.tone }
    ]
  }
}
