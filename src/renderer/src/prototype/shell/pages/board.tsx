/**
 * 副屏（第二块屏上的常驻条，124a）。
 *
 * 它不是第二个面板：320 宽、只有六项，全部来自与浮层同一份快照
 * （`window.api.matchSnapshot()`）。缺块只填 null，不报警、不猜。
 */
import * as React from 'react'

import { Pill } from '../kit'
import { C, FS, MONO, SP } from '../tokens'

/** 六项里的五项直接来自快照；最后一帧的年龄用它自己的 `at` 算。 */
type Snapshot = {
  at: number
  matchid: string | null
  gameState: string
  clockTime: number
  hero: { name: string; level: number; alive: boolean; respawnIn: number | null } | null
}

const FALLBACK_LINE = '3:03 · 白天 · 影魔 Lv7 · 1200 金 · 3/1/5 · 技能 3 · 装备 1'

/** GSI 原值只留后缀，面板上要短标签。 */
function shortState(raw: string): string {
  const map: Record<string, string> = {
    DOTA_GAMERULES_STATE_INIT: '初始化',
    DOTA_GAMERULES_STATE_WAIT_FOR_PLAYERS_TO_LOAD: '载入中',
    DOTA_GAMERULES_STATE_HERO_SELECTION: '选人',
    DOTA_GAMERULES_STATE_STRATEGY_TIME: '开局前',
    DOTA_GAMERULES_STATE_PRE_GAME: '买装',
    DOTA_GAMERULES_STATE_GAME_IN_PROGRESS: '对局中',
    DOTA_GAMERULES_STATE_POST_GAME: '赛后'
  }
  return map[raw] ?? raw.replace('DOTA_GAMERULES_STATE_', '')
}

/** `clockTime` 负数 = 选人倒计时。 */
function clock(seconds: number): string {
  const left = Math.abs(seconds)
  const mm = Math.floor(left / 60)
  const ss = String(left % 60).padStart(2, '0')
  return seconds < 0 ? `-${mm}:${ss}` : `${mm}:${ss}`
}

function age(ms: number): { text: string; tone: 'ok' | 'warn' | 'bad' } {
  const s = ms / 1000
  if (s < 6) return { text: `${s.toFixed(1)} s 前`, tone: 'ok' }
  if (s < 90) return { text: `${Math.round(s)} s 前`, tone: 'warn' }
  return { text: `${Math.round(s / 60)} 分钟前 · 早断了`, tone: 'bad' }
}

const SNAP: Snapshot = {
  at: Date.now() - 1200,
  matchid: '7781234901',
  gameState: 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS',
  clockTime: 183,
  hero: { name: '影魔', level: 7, alive: false, respawnIn: 12 }
}

export function BoardPage(): React.ReactElement {
  const [snap, setSnap] = React.useState<Snapshot | null>(SNAP)
  const fresh = age(Date.now() - (snap?.at ?? 0))

  const rows: [string, React.ReactNode][] = snap
    ? [
        ['局号', <span style={{ fontFamily: MONO }}>{snap.matchid ?? '—'}</span>],
        ['状态', <Pill tone="ok">{shortState(snap.gameState)}</Pill>],
        ['比赛时间', <span style={{ fontFamily: MONO }}>{clock(snap.clockTime)}</span>],
        [
          '我玩',
          snap.hero ? (
            `${snap.hero.name} · Lv${snap.hero.level}`
          ) : (
            <span style={{ color: C.dim }}>—</span>
          )
        ],
        [
          '存活',
          snap.hero ? (
            snap.hero.alive ? (
              <Pill tone="ok">活着</Pill>
            ) : (
              <Pill tone="bad">复活 {snap.hero.respawnIn ?? '?'} s</Pill>
            )
          ) : (
            <span style={{ color: C.dim }}>—</span>
          )
        ],
        ['最后一帧', <Pill tone={fresh.tone}>{fresh.text}</Pill>]
      ]
    : []

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: SP.gap }}>
      <div style={{ fontSize: FS.small, color: C.dim }}>
        第二块屏上只有这么一条，320 宽。它和浮层读的是同一份快照 —— 不是第二个 GSI 读取端。
      </div>

      <div style={{ display: 'flex', gap: 18, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        {/* 那块 320 宽的条 */}
        <div
          style={{
            width: 320,
            border: `1px solid ${C.line2}`,
            borderRadius: 10,
            background: C.card,
            overflow: 'hidden'
          }}
        >
          <div
            style={{
              padding: '9px 12px',
              borderBottom: `1px solid ${C.line}`,
              display: 'flex',
              alignItems: 'center',
              gap: 8
            }}
          >
            <span style={{ fontSize: FS.small }}>这一局</span>
            <span style={{ marginLeft: 'auto' }}>
              <Pill tone={fresh.tone}>{fresh.text}</Pill>
            </span>
          </div>
          {rows.length === 0 ? (
            <div style={{ padding: '14px 12px', fontSize: FS.small, color: C.dim }}>
              没有快照：先把 GSI 那条连通（总览 → 对局正文）。
            </div>
          ) : (
            rows.map(([k, v], i) => (
              <div
                key={k}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  padding: '9px 12px',
                  borderTop: i === 0 ? 'none' : `1px solid ${C.line}`,
                  fontSize: FS.small
                }}
              >
                <span style={{ color: C.dim, width: 62 }}>{k}</span>
                <span style={{ marginLeft: 'auto', color: C.text }}>{v}</span>
              </div>
            ))
          )}
          <div
            style={{
              padding: '9px 12px',
              borderTop: `1px solid ${C.line}`,
              fontSize: FS.mini,
              color: C.dim,
              fontFamily: MONO,
              lineHeight: 1.6
            }}
          >
            {FALLBACK_LINE}
          </div>
        </div>

        {/* 三条操作：都是「不该发生」的证明 */}
        <div style={{ flex: '1 1 320px', display: 'flex', flexDirection: 'column', gap: SP.gap }}>
          {[
            ['开关它不动浮层', '副屏与浮层共用一个快照；关掉副屏，浮层上的东西一个都不该变。'],
            ['关掉它不碰游戏', '它只读快照，不注入、不按键、不改 Dota 设置。'],
            ['缺块就写 —', '`hero` 不在这一帧里就是 null，写成 —，不许猜成 Lv1，也不许进断流告警。']
          ].map(([t, d]) => (
            <div
              key={t}
              style={{ border: `1px solid ${C.line}`, borderRadius: 9, padding: '10px 12px' }}
            >
              <div style={{ fontSize: FS.small }}>{t}</div>
              <div style={{ fontSize: FS.mini, color: C.dim, marginTop: 5, lineHeight: 1.6 }}>
                {d}
              </div>
            </div>
          ))}
          <button
            onClick={() => setSnap((prev) => (prev ? null : SNAP))}
            style={{
              alignSelf: 'flex-start',
              padding: '6px 10px',
              borderRadius: 7,
              border: `1px solid ${C.line2}`,
              background: C.card2,
              color: C.text,
              fontSize: FS.small,
              cursor: 'pointer'
            }}
          >
            {snap ? '模拟「没有快照」' : '恢复快照'}
          </button>
        </div>
      </div>
    </div>
  )
}
