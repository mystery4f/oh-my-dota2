/**
 * #132：战况带（momentum）——**说差距，不说胜率**。
 *
 * 为什么不给概率：`andreiapostoae/dota2-predictor` 用赛后完整特征也只到 0.65 ROC AUC；
 * 局内少得多的信息算出来的任何百分比都是在「用更确定的语气撒谎」。所以这里只有
 * 谁占优、差多少（金币与塔）、以及条的宽度——宽度是给人看的相对量，不是概率。
 *
 * 数据不足时不画：`momentumOf` 缺任意一边的经济就返回 `null`，绝不退化成「五五开」或 50%。
 */

/** 差距小到这个数以内算持平：一千五以下的金币差在局内噪声里。 */
export const MOMENTUM_EVEN_GOLD = 1500
/** 档位边界：小幅 / 明显 / 大幅。 */
export const MOMENTUM_TIER_GOLD = [4000, 10000] as const
/** 条满宽对应的金币差：再大的领先也只画满，不溢出。 */
export const MOMENTUM_FULL_GOLD = 20000

export type MomentumSide = 'radiant' | 'dire' | 'even'

export interface MomentumInput {
  radiantNetWorth: number | null
  direNetWorth: number | null
  /** 双方还剩几座塔；不知道就传 null（那就只说金币）。 */
  radiantTowers?: number | null
  direTowers?: number | null
}

export interface MomentumBand {
  side: MomentumSide
  /** 绝对值：谁领先多少金币。 */
  leadGold: number
  /** 正数表示天辉多几座塔（负数表示夜魇多），不知道塔时为 null。 */
  leadTowers: number | null
  /** 0–100，条宽；持平是 0（不是 50），领先越大越接近 100。 */
  widthPercent: number
  /** 给人看的一句：只含金币/塔与「领先」这类词，没有百分比、没有胜率。 */
  label: string
  /** 两个输入原样写出来：用户能自己判断这条带靠不靠谱。 */
  detail: string
}

function known(value: number | null | undefined): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

/** 金币差 → 条宽。持平给 0，满额封顶 100；中间线性，不做指数放大（放大就是把噪声画成趋势）。 */
export function widthFor(leadGold: number): number {
  if (!Number.isFinite(leadGold) || leadGold <= MOMENTUM_EVEN_GOLD) return 0
  const span = MOMENTUM_FULL_GOLD - MOMENTUM_EVEN_GOLD
  const ratio = (leadGold - MOMENTUM_EVEN_GOLD) / span
  return Math.max(1, Math.min(100, Math.round(ratio * 100)))
}

/** 带上的那句话。档位只影响措辞，不影响条的宽度。 */
export function labelFor(side: MomentumSide, leadGold: number, leadTowers: number | null): string {
  if (side === 'even') return '双方经济持平'
  const who = side === 'radiant' ? '天辉' : '夜魇'
  const gold = `${(leadGold / 1000).toFixed(1)}k`
  const tier = leadGold >= MOMENTUM_TIER_GOLD[1] ? '大幅领先' : leadGold >= MOMENTUM_TIER_GOLD[0] ? '明显领先' : '略占上风'
  const towers = leadTowers === null || leadTowers === 0 ? '' : ` · ${leadTowers > 0 ? '塔多' : '塔少'} ${Math.abs(leadTowers)}`
  return `${who}${tier} ${gold}${towers}`
}

/**
 * 算这一拍的战况带；数据不足（任一边经济未知）返回 `null`。
 */
export function momentumOf(input: MomentumInput): MomentumBand | null {
  if (!known(input.radiantNetWorth) || !known(input.direNetWorth)) return null
  const radiant = input.radiantNetWorth
  const dire = input.direNetWorth
  const leadGold = Math.abs(radiant - dire)
  const towersKnown = known(input.radiantTowers) && known(input.direTowers)
  const leadTowers = towersKnown ? (input.radiantTowers as number) - (input.direTowers as number) : null
  const side: MomentumSide = leadGold <= MOMENTUM_EVEN_GOLD ? 'even' : radiant > dire ? 'radiant' : 'dire'
  const detail = towersKnown
    ? `天辉 ${(radiant / 1000).toFixed(1)}k 塔 ${input.radiantTowers} / 夜魇 ${(dire / 1000).toFixed(1)}k 塔 ${input.direTowers}`
    : `天辉 ${(radiant / 1000).toFixed(1)}k / 夜魇 ${(dire / 1000).toFixed(1)}k（塔数未知）`
  return {
    side,
    leadGold,
    leadTowers,
    widthPercent: widthFor(leadGold),
    label: labelFor(side, leadGold, leadTowers),
    detail
  }
}

/**
 * 探针与文案审查共用的规则：这段文字里**不许**出现任何读起来像概率的东西。
 * 单独导出，是为了让「不写胜率」这件事只有一条判据。
 */
export const PROBABILITY_WORDS = ['%', '胜率', '概率', '几率', '赢面'] as const

/** 这句文案是否干净（不含概率型表达）。 */
export function readsAsProbability(text: string): boolean {
  return PROBABILITY_WORDS.some((word) => text.includes(word))
}