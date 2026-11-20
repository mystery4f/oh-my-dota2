import { exitProbe, probeCases } from './harness'
import { HOTWORD_LIMIT } from '@shared/asr-hotwords'
import {
  CANDIDATE_LIMIT,
  EMPTY_TALLY,
  dismissCandidates,
  mergePlan,
  parseTally,
  rankCandidates,
  recordCorrection
} from '@shared/asr-hotword-candidates'

/**
 * 热词候选探针（--hotword-candidates-probe）：只测 `@shared/asr-hotword-candidates.ts`。
 *
 * 不碰真实 userData——记一次纠错就往真实候选池里添一笔，探针跑一轮就污染一轮。
 * 钉的口径：差异要 ≥2 字才进池、计数与证据分开、表满时不静默替换、脏数据当空池。
 */
export function runHotwordCandidatesProbe(): void {
  const { cases, push } = probeCases()

  const one = recordCorrection(EMPTY_TALLY, '我们打个哈斯卡', '我们打个马尔斯')
  push(
    '一次纠错记一个候选：差异词「马尔斯」，count=1，sample 是原句',
    one.corrections === 1 &&
      one.candidates.length === 1 &&
      one.candidates[0]?.word === '马尔斯' &&
      one.candidates[0]?.count === 1 &&
      one.candidates[0]?.samples[0] === '我们打个哈斯卡',
    JSON.stringify(one)
  )

  const third = recordCorrection(
    recordCorrection(one, '我们打个哈斯卡', '我们打个马尔斯'),
    '我们打个哈斯卡',
    '我们打个马尔斯'
  )
  push(
    '同一个词纠三次：count=3，原句样本只收一次',
    third.corrections === 3 &&
      third.candidates.some(
        (c) => c.word === '马尔斯' && c.count === 3 && c.samples.length === 1 && c.samples.includes('我们打个哈斯卡')
      ),
    JSON.stringify(third.candidates.find((c) => c.word === '马尔斯'))
  )

  const noDiff = recordCorrection(third, '什么情况', '什么情况')
  push(
    '改后等于改前：计数涨、候选不动',
    noDiff.corrections === 4 && JSON.stringify(noDiff.candidates) === JSON.stringify(third.candidates),
    JSON.stringify(noDiff)
  )

  const multi = recordCorrection(EMPTY_TALLY, '准备雾了，情况不明', '准备打盾了，情况明朗')
  push(
    '一次纠错能拆出多个候选：「打盾了」「情况明朗」',
    multi.candidates.length === 2 &&
      multi.candidates.some((c) => c.word === '打盾了') &&
      multi.candidates.some((c) => c.word === '情况明朗'),
    JSON.stringify(multi.candidates)
  )

  let ranked = recordCorrection(EMPTY_TALLY, '来打个肉山', '来打个马尔斯')
  ranked = recordCorrection(ranked, '准备好啊', '准备好肉山')
  ranked = recordCorrection(ranked, '准备好啊', '准备好肉山')
  push(
    'count 是主键：肉山(2) 排在马尔斯(1) 前',
    ranked.candidates[0]?.word === '肉山' && ranked.candidates[1]?.word === '马尔斯',
    JSON.stringify(ranked.candidates.map((c) => `${c.word}×${c.count}`).join(' '))
  )

  const singleWord = recordCorrection(EMPTY_TALLY, '打个', '打个！')
  push(
    '只改标点（差异为空）没有候选；只改一个字的差异也不进池子',
    singleWord.candidates.length === 0,
    JSON.stringify(singleWord.candidates)
  )

  let capped = EMPTY_TALLY
  for (let i = 0; i < CANDIDATE_LIMIT + 5; i += 1) {
    capped = recordCorrection(capped, `改${i}废话`, `词${i}好话`)
  }
  push(
    `池子上限 ${CANDIDATE_LIMIT}：多记 5 次也不超；corrections 照记`,
    capped.candidates.length === CANDIDATE_LIMIT && capped.corrections === CANDIDATE_LIMIT + 5,
    `candidates=${capped.candidates.length} corrections=${capped.corrections}`
  )

  const withTable = rankCandidates(one.candidates, '马尔斯')
  push(
    '词已在热词表里 → inTable=true（面板默认不勾，省去替程序去重）',
    withTable.length === 1 && withTable[0]?.inTable === true,
    JSON.stringify(withTable)
  )
  const withoutTable = rankCandidates(one.candidates, '')
  push(
    '空词表 → inTable=false',
    withoutTable.length === 1 && withoutTable[0]?.inTable === false,
    JSON.stringify(withoutTable)
  )

  const plan = mergePlan('冰甲,捍卫', ['捍卫', '肉山', '泰坦'])
  push(
    '合并计划：已有词进 already、新词进 added、next 是规范化串',
    plan.already.includes('捍卫') &&
      plan.added.includes('肉山') &&
      plan.added.includes('泰坦') &&
      plan.next === '冰甲,捍卫,肉山,泰坦',
    JSON.stringify(plan)
  )

  const full: string[] = []
  for (let i = 0; i < HOTWORD_LIMIT; i += 1) full.push(`词${i}`)
  const fullPlan = mergePlan(full.join(','), ['泰坦'])
  push(
    `表满（${HOTWORD_LIMIT} 词）：新词进 dropped、next 不变——先让人看见再决定要不要清表`,
    fullPlan.dropped.includes('泰坦') && fullPlan.next === full.join(','),
    JSON.stringify(fullPlan.dropped)
  )
  const edgePlan = mergePlan(full.slice(0, HOTWORD_LIMIT - 1).join(','), ['泰坦', '风'])
  push(
    '表差一个词：第一个进 added、第二个进 dropped',
    edgePlan.added.includes('泰坦') && edgePlan.dropped.includes('风'),
    JSON.stringify({ added: edgePlan.added, dropped: edgePlan.dropped })
  )

  const dismissed = dismissCandidates(third, ['马尔斯'])
  push(
    '忽略后计数保留、候选被摘掉',
    dismissed.corrections === 3 && dismissed.candidates.length === 0,
    JSON.stringify(dismissed)
  )

  const junk = parseTally({ corrections: '三', candidates: [{ word: '甲', samples: 'x' }, { word: '' }, null] })
  push(
    '脏数据当空池：计数非数字清零、坏候选行跳过、空词跳过',
    junk.corrections === 0 && junk.candidates.length === 0,
    JSON.stringify(junk)
  )

  const failed = cases.filter((item) => !item.ok)
  for (const item of cases) console.log(`${item.ok ? 'ok  ' : 'FAIL'} ${item.name}  (${item.detail})`)
  console.log(
    'HOTWORD_CANDIDATES_PROBE',
    JSON.stringify({ ok: failed.length === 0, passed: cases.length - failed.length, failed: failed.length })
  )
  exitProbe(failed.length === 0)
}
