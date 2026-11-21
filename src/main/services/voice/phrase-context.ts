/**
 * 短语变量的取值来源（#117）：最近一帧 GSI 里的「谁」与「什么时候」。
 *
 * 不缓存到盘、不跨对局复用：上一局的英雄拿来填这一局的话，比空着更糟。
 * 超过 `STALE_MS` 没新帧就当拿不到（和 `gsi-match.ts` 的归属判定同量级）。
 */
import { formatGameTime, type PhraseVars } from '@shared/quick-phrases'

export const PHRASE_STALE_MS = 90_000

interface PhraseFacts {
  hero: string | null
  clockSec: number | null
  matchid: string | null
  at: number
}

let facts: PhraseFacts = { hero: null, clockSec: null, matchid: null, at: 0 }

/** GSI 每帧喂一次。字段按 Source 2 的形状取值，缺就留 null。 */
export function notePhraseFrame(payload: {
  hero?: { name?: string } | null
  player?: { name?: string } | null
  map?: { matchid?: string | number | null; clock_time?: number | null } | null
}): void {
  const hero = payload.hero?.name ?? null
  const clock = payload.map?.clock_time
  const matchid = payload.map?.matchid
  facts = {
    hero: typeof hero === 'string' && hero !== '' ? hero : facts.hero,
    clockSec: typeof clock === 'number' && Number.isFinite(clock) ? clock : facts.clockSec,
    matchid: matchid === undefined || matchid === null || matchid === '' ? facts.matchid : String(matchid),
    at: Date.now()
  }
}

/** 当前变量；超过 `PHRASE_STALE_MS` 没帧就一律 null（不拿上一局的英雄填这一局）。 */
export function phraseVars(now = Date.now()): PhraseVars {
  if (facts.at === 0 || now - facts.at > PHRASE_STALE_MS) {
    return { hero: null, time: null, matchid: null }
  }
  return { hero: facts.hero, time: formatGameTime(facts.clockSec), matchid: facts.matchid }
}

/** 探针用：清空，回到「没有活帧」。 */
export function resetPhraseFacts(): void {
  facts = { hero: null, clockSec: null, matchid: null, at: 0 }
}
