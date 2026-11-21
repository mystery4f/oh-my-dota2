/**
 * --quick-phrases-probe：快捷短语的分组与变量（#117）。
 *
 * 票面两条验收钉在这里：带变量的短语用当前对局的值渲染；没有短语的组不显示（不是显示成空壳）。
 * 另加三条容易被写错的口径：认不出的占位符原样留着、变量拿不到时也原样留着、
 * 上一局的英雄不许填这一局的话。
 */
import {
  flattenGroups,
  formatGameTime,
  phrasesLine,
  phraseVariables,
  renderGroups,
  renderPhrase,
  visibleGroups
} from '@shared/quick-phrases'
import { notePhraseFrame, phraseVars, resetPhraseFacts, PHRASE_STALE_MS } from '../services/voice/phrase-context'
import { finishProbe, probeCases } from './harness'

export function runQuickPhrasesProbe(): void {
  const { cases, push } = probeCases()
  const vars = { hero: '影魔', time: '12:34', matchid: '7512345678' }

  const one = renderPhrase('{hero} 别推线，{time} 了', vars)
  push('带变量的短语渲染成当前对局的值', one.text === '影魔 别推线，12:34 了', one.text)
  push('全都有值时没有缺变量', one.missing.length === 0)

  const missing = renderPhrase('{hero} 在 {time}', { hero: null, time: '03:00', matchid: null })
  push('拿不到的变量原样留着，不吞成空白', missing.text === '{hero} 在 03:00', missing.text)
  push('缺的变量单独报出来', missing.missing.join(',') === 'hero', missing.missing.join(','))

  const typo = renderPhrase('{heor} 别推线', vars)
  push('认不出的占位符原样留着（打错字看得见）', typo.text === '{heor} 别推线', typo.text)
  push('认不出的不算缺变量', typo.missing.length === 0)

  push('一句里用到的变量列得出来', phraseVariables('{hero} {time} {hero}').join(',') === 'hero,time')

  const groups = [
    { name: ' 对线期 ', phrases: [' 别推线 ', '', ' 拉野 '] },
    { name: '空组', phrases: ['   '] },
    { name: '  ', phrases: ['没有名字的组'] }
  ]
  const shown = visibleGroups(groups)
  push('没有短语的组不显示（票面验收第二条）', shown.length === 1 && shown[0].name === '对线期', JSON.stringify(shown))
  push('组名与短语都 trim，空短语丢掉', shown[0].phrases.join(',') === '别推线,拉野')

  const rendered = renderGroups(['老短语一', '  ', '老短语二'], groups, vars)
  push('未分组的老短语单独成一组排在最前（顺序不变）', rendered[0].name === '未分组' && rendered[0].phrases.join(',') === '老短语一,老短语二', JSON.stringify(rendered.map((g) => g.name)))
  push('空组在渲染列表里也不出现', rendered.length === 2)

  push('平铺保留原顺序（老用户改过的顺序不被分组打乱）', flattenGroups(['b', 'a'], [{ name: 'g', phrases: ['c'] }]).join(',') === 'b,a,c')
  push('一行摘要带组数、句数与缺变量', phrasesLine(renderGroups(['{hero} 上'], [], { hero: null, time: null, matchid: null })) === '1 组 · 1 句 · 缺变量 hero', phrasesLine(renderGroups(['{hero} 上'], [], { hero: null, time: null, matchid: null })))
  push('没有短语时说「还没有」，不是「0 组」', phrasesLine([]) === '还没有快捷短语')

  push('游戏时间按分:秒，拿不到返回 null（不写 00:00）', formatGameTime(754) === '12:34' && formatGameTime(null) === null && formatGameTime(0) === '0:00')

  // —— 真入口：GSI 喂帧 → 变量 ——
  resetPhraseFacts()
  push('没有活帧拿不到任何变量', phraseVars().hero === null && phraseVars().time === null)
  const now = Date.now()
  notePhraseFrame({ hero: { name: 'npc_dota_hero_nevermore' }, map: { matchid: 7512345678, clock_time: 754 } })
  const live = phraseVars(now)
  push('喂一帧就带上英雄、时间、局号', live.hero === 'npc_dota_hero_nevermore' && live.time === '12:34' && live.matchid === '7512345678', JSON.stringify(live))
  push('超过 90 秒没新帧就不再给值（不拿上一局填这一局）', phraseVars(now + PHRASE_STALE_MS + 1).hero === null)
  notePhraseFrame({ map: { clock_time: 900 } })
  push('后续帧缺英雄时沿用上一次的英雄', phraseVars().hero === 'npc_dota_hero_nevermore')
  resetPhraseFacts()

  finishProbe('QUICK_PHRASES_PROBE', cases, {
    groups: shown.length,
    rendered: rendered.length
  })
}
