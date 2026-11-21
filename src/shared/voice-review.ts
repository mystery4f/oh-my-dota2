/**
 * #98：先把识别结果改对，再送出去。
 *
 * 链路本来就把识别结果交回渲染层（`transcribeAudio` 的结果在前、`voiceReply` 在后），
 * 中间那一步「人改一遍」只是没人接。这里只定义**判定**，不定义界面：
 *
 * - 改过就用改过的：非空且与识别原文不同 → 翻译与朗读都吃这一版；
 * - 改空了不当改：一声清空不能把一句吞掉，回落识别原文（现在的行为）；
 * - 只有真改过才进纠错集：一样的文本重复记一次会把候选池灌成噪声，
 *   「未编辑的行与今天完全一样」是票面验收的一条。
 */

/** 编辑句的判定结果。 */
export interface VoiceReview {
  /** 真正要送出去的那一句：改过就是改过的，没改就是识别的。 */
  text: string
  /** 人是不是真的改过（决定要不要记纠错对、要不要提示）。 */
  edited: boolean
  /** 要记进纠错集的样本对；没改过为 null。 */
  pair: { before: string; after: string } | null
}

/** 判定一句该用哪一版；空编辑回落原文，不算改过。 */
export function reviewOf(input: { transcript: string; edited?: string | null }): VoiceReview {
  const transcript = String(input.transcript ?? '').trim()
  const edited = String(input.edited ?? '').trim()
  if (edited === '' || edited === transcript) return { text: transcript, edited: false, pair: null }
  return { text: edited, edited: true, pair: { before: transcript, after: edited } }
}

/** 面板上那句话：只有真改过才说「按你改的说」，别对没改的行也絮叨。 */
export function reviewLine(review: VoiceReview): string {
  return review.edited ? '按你改过的那句翻译和朗读' : ''
}