/**
 * 影子模式（#80）的判断缝：三个状态、拦不拦、报告怎么数、那句话怎么说。
 *
 * 为什么值得一个探针：这一层的失败方式全都很安静——第一局本该不出声却出了声（用户
 * 被自己没核对过的合成音吓一跳），或者第一局过后还在影子（用户以为声出坏了）。
 * 两个方向都不会抛错，只能在断言里钉住。
 */
import { join } from 'node:path'
import { logsDir } from '../services/logs/base-dir'
import { finishProbe, probeCases } from './harness'
import { shadowVoicePath } from '../services/voice/shadow'
import {
  shadowBlocks,
  shadowLine,
  shadowState,
  shadowView,
  summarizeShadow,
  type ShadowRow
} from '@shared/shadow-voice'

const rows: ShadowRow[] = [
  { at: '2026-11-21T10:00:02.000Z', matchid: '7000000002', text: '买个粉' },
  { at: '2026-11-21T10:00:09.000Z', matchid: '7000000002', text: '他们有个隐身' },
  { at: '2026-11-21T10:00:01.000Z', matchid: null, text: '小心 gank' }
]

export function runShadowVoiceProbe(): void {
  const { cases, push } = probeCases()

  // —— 三态：只有「开着且还没打完过一局」才影子 ——
  push('关掉就是 off（一局都不影子）', shadowState({ enabled: false, matchesSeen: 0 }) === 'off')
  push('开着且一局没打过是 active', shadowState({ enabled: true, matchesSeen: 0 }) === 'active')
  push('打完一局自动结束（不用人回来关）', shadowState({ enabled: true, matchesSeen: 1 }) === 'done')
  push('关掉之后即使打过局也是 off', shadowState({ enabled: false, matchesSeen: 3 }) === 'off')

  // —— 拦不拦 ——
  push('只在 active 拦下出声', shadowBlocks('active') && !shadowBlocks('done') && !shadowBlocks('off'))

  // —— 报告：条数、字数、最近时间 ——
  const empty = summarizeShadow([])
  push('空报告：0 条 / 0 字 / 没有时间', empty.count === 0 && empty.chars === 0 && empty.newest === null)
  const report = summarizeShadow(rows)
  push('条数按行数算', report.count === 3, `count=${report.count}`)
  const chars = '买个粉'.length + '他们有个隐身'.length + '小心 gank'.length
  push('字数按字符总数算', report.chars === chars, `chars=${report.chars}`)
  push('最近时间取最大值，不是数组末尾', report.newest === '2026-11-21T10:00:09.000Z', report.newest ?? '')
  push(
    '样例最多 3 条且新的在前',
    report.sample.length === 3 && report.sample[0].text === '他们有个隐身',
    report.sample[0]?.text ?? ''
  )
  push('样例条数可调', summarizeShadow(rows, 1).sample.length === 1)

  // —— 那句话：三态各说各的，且都提到「出不出声」这件事 ——
  const offLine = shadowLine('off', empty)
  const activeLine = shadowLine('active', summarizeShadow(rows))
  const doneLine = shadowLine('done', report)
  push('三态文案互不相同', offLine !== activeLine && activeLine !== doneLine && offLine !== doneLine)
  push('active 文案说清「先不出声」', activeLine.includes('不出声'), activeLine)
  push('active 文案带上条数与字数', activeLine.includes('3 句') && activeLine.includes(`${chars} 字`))
  push('没记到东西时 active 也说得明白', shadowLine('active', empty).includes('不合成'))
  push('done 文案回指第一局记了多少', doneLine.includes('3 句'), doneLine)
  push('off 文案说明会直接出声', offLine.includes('出声'), offLine)

  // —— 面板那一行：状态、报告、那句话同源 ——
  const view = shadowView('active', summarizeShadow(rows))
  push('view 里的 line 与 shadowLine 同源', view.line === shadowLine('active', summarizeShadow(rows)))
  push('view 保留状态与报告', view.state === 'active' && view.report.count === 3)

  // —— 落盘路径：探针跑在临时 logs 根，真实 data/logs 一个字都不写 ——
  push(
    '影子账本就在 logsDir 下（探针根是临时目录，真实 data/logs 不沾）',
    shadowVoicePath() === join(logsDir(), 'shadow-voice.jsonl'),
    shadowVoicePath()
  )

  finishProbe('SHADOW_VOICE_PROBE', cases, { path: shadowVoicePath() })
}
