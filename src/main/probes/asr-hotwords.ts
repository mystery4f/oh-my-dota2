import { exitProbe } from './harness'
import {
  HOTWORD_LIMIT,
  HOTWORD_PROMPT_LIMIT,
  extractHotwordDiff,
  hotwordEcho,
  hotwordPrompt,
  joinHotwords,
  mergeHotwords,
  parseHotwords
} from '@shared/asr-hotwords'

/**
 * `--asr-hotwords-probe`：热词纯函数缝的全量行为锁（解析/差异提取/合并）。
 * 纯字符串处理，零引擎零网络；引擎侧 hotwords 生效性由真机 A/B 验收（docs/ACCEPTANCE.md）。
 */

interface Row {
  name: string
  ok: boolean
  detail: string
}

const cases: Row[] = []

function push(name: string, ok: boolean, detail: string): void {
  cases.push({ name, ok, detail })
}

export function runAsrHotwordsProbe(): void {
  // —— 解析：分隔符、去重、空值 ——
  push(
    '中英文逗号/顿号/分号/空白都能切开',
    JSON.stringify(parseHotwords('肉山，买活、风暴之灵;高地 推塔')) === JSON.stringify(['肉山', '买活', '风暴之灵', '高地', '推塔']),
    JSON.stringify(parseHotwords('肉山，买活、风暴之灵;高地 推塔'))
  )
  push('重复词去重', JSON.stringify(parseHotwords('肉山,肉山， 肉山')) === JSON.stringify(['肉山']), JSON.stringify(parseHotwords('肉山,肉山， 肉山')))
  push('空串/纯分隔符 → 空表', parseHotwords('').length === 0 && parseHotwords(',,、 ').length === 0, JSON.stringify(parseHotwords(',,、 ')))
  push('join 后可原样 parse 回来', JSON.stringify(parseHotwords(joinHotwords(['a', 'b']))) === JSON.stringify(['a', 'b']), joinHotwords(['a', 'b']))

  // —— 差异提取：改对的那截 ——
  const mid = extractHotwordDiff('谁买活了？我先守肉山，你们推上路高地。', '谁买活了？我先手肉山，你们推上路高地。')
  push('句中单字改对 → 提不出 ≥2 字片段（单字噪声太大，人工手补）', mid.length === 0, JSON.stringify(mid))
  const term = extractHotwordDiff('我先守肉山', '我先手肉山帕克')
  push('补词：差异片段按标点/边界切出', JSON.stringify(term) === JSON.stringify(['手肉山帕克']), JSON.stringify(term))
  const multi = extractHotwordDiff('守肉山', '拿肉山，开雾')
  push('差异跨标点 → 只留干净片段', JSON.stringify(multi) === JSON.stringify(['拿肉山', '开雾']), JSON.stringify(multi))
  push('完全没改 → 空', extractHotwordDiff('一样的', '一样的').length === 0, '')
  push('全删 → 新文本没有可留的片段 → 空', extractHotwordDiff('守肉山拿盾', '').length === 0, '')
  push('整句重写 → 收进片段（上限 8 个）', extractHotwordDiff('', '肉山,买活,高地,推塔,开雾,反补,正补,帕克,斧王,先知').length === 8, '')

  // —— 回声：模型没听到话，把提示念了一遍（2026-11-13 线上 bug） ——
  const table = '肉山,野,野怪,上路,中路,下路,神符,符,打钱'
  const echo = '肉山 野 野怪 上路 中路 下路 神符 符 打钱'
  push('整表被念一遍 → 认成回声', hotwordEcho(echo, table), JSON.stringify(hotwordEcho(echo, table)))
  push('真句子含一个热词 → 不是回声', !hotwordEcho('我们打肉山', table), '')
  push('只有一个片段 → 不是回声', !hotwordEcho('肉山', table), '')
  push('出现表外的词 → 不是回声', !hotwordEcho('肉山 帕克', table), '')
  push('空输出 → 不是回声', !hotwordEcho('', table), '')
  push(
    '末尾多一个句号 → 仍是回声',
    hotwordEcho('肉山 野怪 上路 中路 下路 神符 打钱。', '肉山,野怪,上路,中路,下路,神符,打钱'),
    ''
  )
  // 线上实际看到的形态：没有分隔符，整表粘成一句。
  push(
    '整表粘成一串 → 仍是回声',
    hotwordEcho('肉山野怪上路中路下路神符打钱', '肉山,野怪,上路,中路,下路,神符,打钱'),
    ''
  )
  push(
    '粘连 + 末尾句号 → 仍是回声',
    hotwordEcho('肉山野怪上路中路下路神符打钱。', '肉山,野怪,上路,中路,下路,神符,打钱'),
    ''
  )
  push('两个词粘连（像是真说出来）→ 放过', !hotwordEcho('肉山野怪', '肉山,野怪,上路,中路,下路,神符,打钱'), '')
  push('粘连里混了表外的字 → 放过', !hotwordEcho('肉山野怪推塔', '肉山,野怪,上路,中路,下路,神符,打钱'), '')
  push('整句里带热词 → 放过', !hotwordEcho('我们打肉山野怪', '肉山,野怪,上路,中路,下路,神符,打钱'), '')

  // —— 提示串：单字与子串词先剔掉 ——
  push('单字热词不进提示', hotwordPrompt('肉山,野,野怪,符') === '肉山，野怪', hotwordPrompt('肉山,野,野怪,符'))
  push('只有一个词时原样保留', hotwordPrompt('肉山') === '肉山', hotwordPrompt('肉山'))
  push('空表 → 空串', hotwordPrompt('') === '', '')
  const many = joinHotwords(Array.from({ length: 30 }, (_, i) => `关键词${String(i).padStart(2, '0')}`))
  push(`提示条数封顶 ${HOTWORD_PROMPT_LIMIT}`, parseHotwords(hotwordPrompt(many)).length === HOTWORD_PROMPT_LIMIT, String(parseHotwords(hotwordPrompt(many)).length))

  // —— 合并：去重追加 ——
  push('新词追加到表尾', mergeHotwords('肉山', ['买活', '高地']) === '肉山,买活,高地', mergeHotwords('肉山', ['买活', '高地']))
  push('已在表里的词不重复', mergeHotwords('肉山,买活', ['买活', '帕克']) === '肉山,买活,帕克', mergeHotwords('肉山,买活', ['买活', '帕克']))
  push('空表现接新词', mergeHotwords('', ['肉山']) === '肉山', mergeHotwords('', ['肉山']))

  // —— 容量：HOTWORD_LIMIT 封顶 ——
  const fullWords = Array.from({ length: HOTWORD_LIMIT }, (_, i) => `词${i}`)
  const full = joinHotwords(fullWords)
  push(`表满 ${HOTWORD_LIMIT} 词后新词丢弃、现役词原样`, mergeHotwords(full, ['新词']) === full, '')
  push('表满时并入已存词 → 原样返回', mergeHotwords(full, [fullWords[0]]) === full, '')

  let failed = 0
  for (const item of cases) {
    if (!item.ok) failed++
    console.log(`${item.ok ? 'PASS' : 'FAIL'} | ${item.name} | ${item.detail}`)
  }
  console.log(`ASR_HOTWORDS_PROBE ${cases.length - failed}/${cases.length} PASS`)
  exitProbe(!(failed > 0 ))
}
