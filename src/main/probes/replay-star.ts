/**
 * --replay-star-probe：对局里标一句、复盘时按局读回来（#118）。
 *
 * 钉的是票面那三条验收，而不是 UI：
 * - 星标跨对局边界还读得到（上一局标的两条，换局之后照样按它的 matchid 读出来）；
 * - 没标过的局读出来是空的，不是「全部」；
 * - 归属不明的（当时没有活帧）单独一组，绝不被算进任何一局。
 *
 * 另外钉住两条容易漂的口径：同一行重复标只算一条（取最后一次）、
 * 热键回执永远是一句话（标不上也要说为什么）。
 */
import {
  buildStar,
  dedupeStars,
  starFeedback,
  starKey,
  starLine,
  starsOf,
  summarizeStars,
  type ReplayStar
} from '@shared/replay-star'
import {
  noteReplayStar,
  replayStarSummary,
  replayStarsPath,
  resetReplayStars,
  seedReplayStars
} from '../services/session/replay-stars'
import { logsDir } from '../services/logs/base-dir'
import { finishProbe, probeCases } from './harness'

export function runReplayStarProbe(): void {
  const { cases, push } = probeCases()
  const TAG = 'REPLAY_STAR_PROBE'

  function star(matchid: string | null, id: string, at: string, note = ''): ReplayStar {
    return {
      at,
      matchid,
      entryId: id,
      source: `原句 ${id}`,
      translation: `译文 ${id}`,
      note
    }
  }

  const input = (matchid: string | null, id: string, source: string, translation: string, note = '') => ({
    at: '2026-11-21T12:00:00.000Z',
    matchid,
    entry: { entryId: id, source, translation },
    note
  })

  const emptySource = buildStar(input('7512345678', 'e1', '   ', '译文'))
  push('没原文的行不产生星标', emptySource === null, emptySource === null ? '' : JSON.stringify(emptySource))

  const emptyTranslation = buildStar(input('7512345678', 'e2', '原句', '  '))
  push('没译文的行不产生星标', emptyTranslation === null)

  const blankId = buildStar(input('7512345678', '   ', '原句', '译文'))
  push('没有行号的不产生星标', blankId === null)

  const built = buildStar(input('7512345678', 'e3', ' 原句 ', ' 译文 ', '  打得好  '))
  push(
    '星标保留 matchid、去掉首尾空白、备注跟着走',
    built !== null && built.matchid === '7512345678' && built.source === '原句' && built.translation === '译文' && built.note === '打得好',
    JSON.stringify(built)
  )

  const longNote = buildStar(input('7512345678', 'e4', '原句', '译文', 'x'.repeat(400)))
  push('备注截到 120 字', longNote !== null && longNote.note.length === 120)

  const blankMatch = buildStar(input('   ', 'e5', '原句', '译文'))
  push('matchid 是空白时写成显式 null，不是空串', blankMatch !== null && blankMatch.matchid === null)

  const first = star('A', 'e1', '2026-11-21T12:00:01.000Z')
  const second = star('A', 'e2', '2026-11-21T12:00:02.000Z')
  const remarked = star('A', 'e1', '2026-11-21T12:00:05.000Z', '改主意了')
  const deduped = dedupeStars([first, second, remarked])
  push(
    '同一行重复标只算一条，取最后一次的时间与备注',
    deduped.length === 2 && deduped[0].at === '2026-11-21T12:00:05.000Z' && deduped[0].note === '改主意了',
    JSON.stringify(deduped.map((row) => `${row.entryId}@${row.at}`))
  )

  push('去重键就是行号（去掉空白）', starKey('  e1 ') === 'e1')

  const stars = [first, second, star('B', 'e3', '2026-11-21T12:10:00.000Z'), star(null, 'e4', '2026-11-21T12:20:00.000Z')]
  push('按局读只给这一局的', starsOf(stars, 'A').length === 2 && starsOf(stars, 'B').length === 1)
  push('没标过的局读出来是空的，不是全部', starsOf(stars, 'C').length === 0, `C=${starsOf(stars, 'C').length}`)
  push('归属不明的单独一组', starsOf(stars, null).length === 1 && starsOf(stars, null)[0].entryId === 'e4')

  const summaryA = summarizeStars(stars, 'A')
  push(
    '一局的汇总：条数、全量里出现过几局、最近一条',
    summaryA.total === 2 && summaryA.matches === 2 && summaryA.newest === '2026-11-21T12:00:02.000Z',
    JSON.stringify({ total: summaryA.total, matches: summaryA.matches, newest: summaryA.newest })
  )
  const summaryC = summarizeStars(stars, 'C')
  push('没标过的局：0 条、最近时间为 null', summaryC.total === 0 && summaryC.newest === null)

  push('一句话描述：没标过就说没标过', starLine(null) === '这一局还没标过句子')
  const line = starLine(first)
  push('一句话描述带时刻与备注', line.includes('12:00:01') && line.includes('标了 1 句'), line)

  push('标不上时的回执说清楚为什么', starFeedback(null).includes('没标上'), starFeedback(null))
  push('标上了的回执带上 matchid', starFeedback(first).includes('A'))
  push('归属不明的回执明说「归属不明」', starFeedback(star(null, 'e9', '2026-11-21T12:00:00.000Z')).includes('归属不明'))

  // —— 真入口与落盘 ——
  push(
    '记录写在 logs 根下（探针模式就是临时根）',
    replayStarsPath() === `${logsDir()}\\replay-stars.jsonl` || replayStarsPath() === `${logsDir()}/replay-stars.jsonl`,
    replayStarsPath()
  )

  resetReplayStars()
  const empty = noteReplayStar()
  push('没有可标的行时返回 null，不凭空造样本', empty === null)
  push('没有可标的行时读出来是 0 条', replayStarSummary(null).total === 0)

  // 跨对局边界：上一局的两条还在，这一局新标的一条不会混进去。
  seedReplayStars([star('M1', 'e1', '2026-11-21T12:00:01.000Z'), star('M1', 'e2', '2026-11-21T12:00:02.000Z')])
  push('换局之前：上一局读得到两条', replayStarSummary('M1').total === 2)
  seedReplayStars([
    star('M1', 'e1', '2026-11-21T12:00:01.000Z'),
    star('M1', 'e2', '2026-11-21T12:00:02.000Z'),
    star('M2', 'e3', '2026-11-21T12:40:00.000Z')
  ])
  push(
    '跨过对局边界：上一局还是两条，新局只有一条',
    replayStarSummary('M1').total === 2 && replayStarSummary('M2').total === 1,
    JSON.stringify({ M1: replayStarSummary('M1').total, M2: replayStarSummary('M2').total })
  )
  push('从没标过的局（M3）读出来是空的', replayStarSummary('M3').total === 0)
  push('全量里出现过两局', replayStarSummary('M1').matches === 2)

  resetReplayStars()
  push('清账之后读不到任何东西', replayStarSummary('M1').total === 0)

  finishProbe(TAG, cases, {
    file: replayStarsPath(),
    stars: stars.length,
    matches: summarizeStars(stars, 'A').matches
  })
}
