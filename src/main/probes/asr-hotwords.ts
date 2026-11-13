import { exitProbe } from './harness'
import { HOTWORD_LIMIT, extractHotwordDiff, joinHotwords, mergeHotwords, parseHotwords } from '@shared/asr-hotwords'

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
