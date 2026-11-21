/**
 * #121 探针：同局同伴画像。
 *
 * 票面验收：
 * - `the same player's later lines reuse the earlier rendering` → 同一局同一个人第二次说同一句，
 *   `lookup` 必须给回第一次的译法（调用方据此免一次翻译请求）；
 * - `a new player starts clean` → 换个人就是空的，不许借用别人的译法；
 * - `the profile is dropped at match end` → 换局/结束局之后整份消失。
 *
 * 另外钉住三条业务边界：匿名行不记（没 speaker 就没有桶）、大小写/空白/句尾标点不算两句、
 * 人数与句数都有上限（画像只是记忆，不是账本）。
 */
import { COMPANION_NO_MATCH, COMPANION_PER_PLAYER_MAX, COMPANION_PLAYERS_MAX, CompanionProfile, profileText } from '@shared/companion-profile'
import { finishProbe, probeCases } from './harness'

export async function runCompanionProfileProbe(): Promise<void> {
  const { cases, push } = probeCases()

  // —— 键的折叠 ——
  push('键：大小写与空白不算两句', profileText('  Care   Mid ') === profileText('care mid'), profileText('  Care   Mid '))
  push('键：句尾标点不算两句', profileText('need ward?') === profileText('need ward'), profileText('need ward?'))
  push('键：句中标点保留（意思不同）', profileText('gg, wp') !== profileText('gg wp'))

  // —— 验收一：同一个人后来的同一句沿用先前的译法 ——
  const profile = new CompanionProfile()
  profile.note('m1', '队友A', 'care mid', '小心中路')
  push('同一人第二次同一句：拿到上次的译法', profile.lookup('m1', '队友A', 'Care Mid') === '小心中路', String(profile.lookup('m1', '队友A', 'Care Mid')))
  push('同一句但换了人：不复用', profile.lookup('m1', '队友B', 'care mid') === null)

  // —— 验收二：新人从头记 ——
  profile.note('m1', '队友B', 'need ward', '插个眼')
  push('新人自己有记录后命中自己的', profile.lookup('m1', '队友B', 'need ward') === '插个眼')
  push('新人的其它句子仍是空的', profile.lookup('m1', '队友B', 'care mid') === null)

  // —— 验收三：换局即清 ——
  push('换局：旧局不复用', profile.lookup('m2', '队友A', 'care mid') === null)
  profile.note('m2', '队友C', 'push top', '推上')
  push('换局时丢掉别的局', profile.dropOtherMatches('m2') === 1 && profile.players('m1') === 0 && profile.players('m2') === 1)
  const fresh = new CompanionProfile()
  fresh.note('m3', '队友A', 'care mid', '小心中路')
  push('对局结束：整份丢掉并报人数', fresh.dropMatch('m3') === 1 && fresh.players('m3') === 0 && fresh.lookup('m3', '队友A', 'care mid') === null)

  // —— 业务边界 ——
  const anon = new CompanionProfile()
  anon.note('m1', '', 'care mid', '小心中路')
  anon.note('m1', '   ', 'need ward', '插个眼')
  push('匿名行不进画像', anon.players('m1') === 0 && anon.lookup('m1', '', 'care mid') === null)
  push('空译文不记（没翻出来就别当成译法）', (() => { const p = new CompanionProfile(); p.note('m1', '队友A', 'care mid', '   '); return p.lookup('m1', '队友A', 'care mid') === null })())

  const capped = new CompanionProfile()
  for (let index = 0; index < COMPANION_PER_PLAYER_MAX + 5; index += 1) capped.note('m1', '队友A', `line ${index}`, `行${index}`)
  push(`每人最多记 ${COMPANION_PER_PLAYER_MAX} 句`, capped.size('m1', '队友A') === COMPANION_PER_PLAYER_MAX, String(capped.size('m1', '队友A')))
  push('超限丢最旧的那句', capped.lookup('m1', '队友A', 'line 0') === null && capped.lookup('m1', '队友A', `line ${COMPANION_PER_PLAYER_MAX + 4}`) !== null)

  const many = new CompanionProfile()
  for (let index = 0; index < COMPANION_PLAYERS_MAX + 2; index += 1) many.note('m1', `p${index}`, 'care mid', `小心中路${index}`)
  push(`一局最多记 ${COMPANION_PLAYERS_MAX} 人`, many.players('m1') === COMPANION_PLAYERS_MAX, String(many.players('m1')))

  push('没有对局时的键是常量，不跟任何一局混', COMPANION_NO_MATCH === 'menu')
  push('一句话说得出这局记了几个人', profile.line('m2').includes('1 个玩家'), profile.line('m2'))

  finishProbe('COMPANION_PROFILE_PROBE', cases)
}