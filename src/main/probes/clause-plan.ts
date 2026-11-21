/**
 * 子句流水探针（#71）：不连模型、不出声，只钉「首句先出、顺序不变、失败只跳这一句」。
 *
 * 为什么能不用真实调用：整条流水把翻译与朗读都当参数传进来（`runClauseStream`），
 * 探针注入带假时钟的假函数，就能把「谁先谁后」量成毫秒数字——这比听一遍更准。
 *
 * 也钉住默认关：开关关着时切出来的就是一整句，走的是升级前那条路。
 */
import { clauseStreamLine, clauseStreamPlan, runClauseStream, splitClauses } from '@shared/clause-plan'
import { finishProbe, probeCases } from './harness'

/** 假时钟：每读一次前进 1 ms，让先后顺序可断言。 */
function fakeClock(): () => number {
  let at = 0
  return () => {
    at += 1
    return at
  }
}

const squash = (text: string): string => text.replace(/\s+/g, '')

export async function runClausePlanProbe(): Promise<void> {
  const { cases, push: check } = probeCases()

  // —— 切句：不丢字、不超上限、不留碎片
  const sample = '他们开雾了。中路不见了，小心！需要买个眼？'
  const clauses = splitClauses(sample)
  check('切句不丢字：拼回来等于原文去掉空白', squash(clauses.join('')) === squash(sample), clauses.join(' | '))
  check('切句按标点落在句读后面', clauses[0] === '他们开雾了。', clauses[0])
  check('太短的碎片并进前一句', !clauses.some((one) => one.length < 4), JSON.stringify(clauses))
  const long = '这句话特别特别长'.repeat(8)
  check('超长子句按上限硬切', splitClauses(long, 12).every((one) => one.length <= 12))
  check('空文本切出空数组', splitClauses('   ').length === 0)

  // —— 开关：默认关就是一整句
  const off = clauseStreamPlan({ text: sample, enabled: false })
  check('开关关着 -> 只有一整句', off.clauses.length === 1 && off.streamed === false, JSON.stringify(off.clauses))
  const oneLine = clauseStreamPlan({ text: '好的。', enabled: true })
  check('只有一个子句 -> 也不算流水', oneLine.streamed === false && oneLine.clauses.length === 1)
  const on = clauseStreamPlan({ text: sample, enabled: true })
  check('开关打开 -> 多句才走流水', on.streamed === true && on.clauses.length >= 3, String(on.clauses.length))

  // —— 顺序：第二句先翻完，朗读也不能插队
  {
    const spoken: string[] = []
    const result = await runClauseStream({
      clauses: ['一', '二'],
      now: fakeClock(),
      translate: async (clause) => {
        // 第二句故意更快返回
        await new Promise((resolve) => setTimeout(resolve, clause === '二' ? 1 : 30))
        return `EN(${clause})`
      },
      speak: async (text) => {
        spoken.push(text)
      }
    })
    check('朗读顺序永远是子句原顺序', spoken.join(',') === 'EN(一),EN(二)', spoken.join(','))
    check('两句都读出来了', result.spoken === 2 && result.skipped === 0)
    check('译文按句带回、与子句对齐', result.texts.join(',') === 'EN(一),EN(二)', result.texts.join(','))
  }

  // —— 首句先出：第一句已经出声时，最后一句的翻译还没回来
  {
    let lastTranslated = false
    const events: string[] = []
    const result = await runClauseStream({
      clauses: ['先', '后'],
      translate: async (clause) => {
        if (clause === '后') {
          await new Promise((resolve) => setTimeout(resolve, 40))
          lastTranslated = true
          events.push('translated:后')
        }
        return `EN(${clause})`
      },
      speak: async (text) => {
        events.push(`speak:${text}`)
        if (text === 'EN(先)') check('首句出声时最后一句还没翻完', lastTranslated === false)
      }
    })
    check('首句出声时间点被记下来了', result.firstSpokenAt !== null && result.firstSpokenAt !== undefined)
    check('事件顺序：先读完首句，再翻完最后一句', events.join(',') === 'speak:EN(先),translated:后,speak:EN(后)', events.join(','))
  }

  // —— 失败只跳这一句
  {
    const spoken: string[] = []
    const result = await runClauseStream({
      clauses: ['坏', '好'],
      now: fakeClock(),
      translate: async (clause) => {
        if (clause === '坏') throw new Error('provider 500')
        return `EN(${clause})`
      },
      speak: async (text) => {
        spoken.push(text)
      }
    })
    check('翻译抛错 -> 只跳这一句', result.outcomes.join(',') === 'skipped,spoken', result.outcomes.join(','))
    check('跳过的句在 texts 里留空位、不挤位', result.texts.join(',') === ',EN(好)', result.texts.join(','))
    check('后面的句子照常朗读', spoken.join(',') === 'EN(好)', spoken.join(','))
  }
  {
    const spoken: string[] = []
    const result = await runClauseStream({
      clauses: ['空', '好'],
      translate: async (clause) => (clause === '空' ? '   ' : 'EN(好)'),
      speak: async (text) => {
        spoken.push(text)
      }
    })
    check('译文为空 -> 这句跳过，不会念出空白', result.outcomes.join(',') === 'skipped,spoken' && spoken.length === 1)
  }
  {
    const spoken: string[] = []
    const result = await runClauseStream({
      clauses: ['甲', '乙'],
      translate: async (clause) => `EN(${clause})`,
      speak: async (text) => {
        if (text === 'EN(甲)') throw new Error('合成失败')
        spoken.push(text)
      }
    })
    check('合成失败 -> 记为 failed，不重试不换引擎', result.outcomes.join(',') === 'failed,spoken', result.outcomes.join(','))
    check('后续子句仍然朗读', spoken.join(',') === 'EN(乙)', spoken.join(','))
  }

  // —— 给人看的那一行
  const line = clauseStreamLine({ outcomes: ['spoken', 'skipped'], texts: ['a', ''], spoken: 1, skipped: 1, firstSpokenAt: 120, endedAt: 900 })
  check('一行账说清读了几句、跳了几句、首句多快', line.includes('子句 2') && line.includes('读 1') && line.includes('跳 1') && line.includes('首句 120ms'), line)

  finishProbe('CLAUSE_PLAN_PROBE', cases)
}
