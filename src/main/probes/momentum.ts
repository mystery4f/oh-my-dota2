/**
 * #132 探针：战况带。
 *
 * 票面验收三条：
 * - `The band never renders a number that reads as a probability` → 合成帧序列上逐档跑文案，
 *   每一条都必须过 `readsAsProbability()`（没有 %、没有胜率/概率/几率/赢面）；
 * - `hovering (or the summon panel row) shows the net-worth and tower deltas behind it` →
 *   `detail` 必须同时写清两边经济与塔数（悬停行的数据来源）；
 * - `with no frames yet it renders nothing rather than "50%"` → 缺任一边经济时 `momentumOf` 返回 `null`，
 *   不是 `even`、不是 50。
 *
 * 另外钉住：持平给 0 宽（不是 50）、档位边界、宽度单调且封顶。
 */
import {
  MOMENTUM_EVEN_GOLD,
  MOMENTUM_FULL_GOLD,
  MOMENTUM_TIER_GOLD,
  momentumOf,
  readsAsProbability,
  widthFor
} from '@shared/momentum'
import { finishProbe, probeCases } from './harness'

export async function runMomentumProbe(): Promise<void> {
  const { cases, push } = probeCases()

  // —— 合成帧序列：从持平到大幅领先，每一拍都要么不画、要么说清差距 ——
  const series = [
    { radiantNetWorth: 40000, direNetWorth: 40000, radiantTowers: 6, direTowers: 6 },
    { radiantNetWorth: 41000, direNetWorth: 39500, radiantTowers: 6, direTowers: 6 },
    { radiantNetWorth: 46000, direNetWorth: 41000, radiantTowers: 7, direTowers: 5 },
    { radiantNetWorth: 56000, direNetWorth: 42000, radiantTowers: 8, direTowers: 4 },
    { radiantNetWorth: 40000, direNetWorth: 62000, radiantTowers: 3, direTowers: 8 }
  ]
  for (const frame of series) {
    const band = momentumOf(frame)
    const text = band === null ? '' : `${band.label} ${band.detail}`
    push(`这一拍没有概率型表达（${frame.radiantNetWorth} vs ${frame.direNetWorth}）`, band !== null && !readsAsProbability(text), text)
    push(
      `悬停数据含两边经济与塔（${frame.radiantNetWorth} vs ${frame.direNetWorth}）`,
      band !== null && band.detail.includes('天辉') && band.detail.includes('夜魇') && band.detail.includes('塔'),
      band?.detail ?? ''
    )
  }

  // —— 没有帧就什么都不画 ——
  push('经济未知：不画（不是五五开）', momentumOf({ radiantNetWorth: null, direNetWorth: 30000 }) === null)
  push('两边都未知：不画', momentumOf({ radiantNetWorth: null, direNetWorth: null }) === null)
  push('NaN 当未知：不画', momentumOf({ radiantNetWorth: Number.NaN, direNetWorth: 30000 }) === null)

  // —— 档位与措辞 ——
  const even = momentumOf({ radiantNetWorth: 40000, direNetWorth: 39000, radiantTowers: 5, direTowers: 5 })
  push('差距在噪声内算持平', even?.side === 'even' && even.widthPercent === 0, even?.label ?? '')
  push('持平不说谁领先', even?.label === '双方经济持平', even?.label ?? '')

  const small = momentumOf({ radiantNetWorth: 43000, direNetWorth: 40000 })
  push('小幅：略占上风', small?.label.includes('略占上风') === true, small?.label ?? '')
  push('小幅不带塔就不提塔', small?.label.includes('塔') === false && small?.leadTowers === null, small?.label ?? '')
  const middle = momentumOf({ radiantNetWorth: 44000, direNetWorth: 40000 })
  push(`明显档边界 ${MOMENTUM_TIER_GOLD[0]}`, middle?.label.includes('明显领先') === true, middle?.label ?? '')
  const big = momentumOf({ radiantNetWorth: 54000, direNetWorth: 40000 })
  push(`大幅档边界 ${MOMENTUM_TIER_GOLD[1]}`, big?.label.includes('大幅领先') === true, big?.label ?? '')
  push('夜魇领先时说的是夜魇', momentumOf({ radiantNetWorth: 30000, direNetWorth: 50000 })?.label.startsWith('夜魇') === true)

  // —— 宽度是相对量，封顶且单调 ——
  push('持平宽度为 0（不是 50）', widthFor(0) === 0 && widthFor(MOMENTUM_EVEN_GOLD) === 0)
  push('领先越大越宽', widthFor(5000) < widthFor(12000) && widthFor(12000) < widthFor(18000))
  push('满额封顶 100', widthFor(MOMENTUM_FULL_GOLD) === 100 && widthFor(MOMENTUM_FULL_GOLD * 3) === 100)
  push('出噪声就有可见宽度', widthFor(MOMENTUM_EVEN_GOLD + 200) >= 1)
  push('塔差写进这句话', momentumOf({ radiantNetWorth: 50000, direNetWorth: 40000, radiantTowers: 8, direTowers: 5 })?.label.includes('塔多 3') === true)

  // —— 概率型表达的判据本身 ——
  push('判据认得出来', readsAsProbability('胜率 62%') && !readsAsProbability('天辉明显领先 4.0k · 塔多 1'))

  finishProbe('MOMENTUM_PROBE', cases)
}