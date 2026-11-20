/**
 * 逐行判方向（#84）：`TranslateDirection` 以前完全由调用方决定，中英混排的那一行可能被送去错的方向。
 *
 * 判据只有一条：汉字占「有意义的字」（汉字 + 拉丁字母）的比例。数字、标点、表情都不进分母，
 * 否则一句 `GG 666` 会被算成半中半英。阈值定在 0.3 而不是 0.5：`push 中路` 这种夹着一个中文词的
 * 行，翻成英文才有意义，翻成中文等于把中文再糟蹋一遍。
 *
 * 会话级更正：浮层里点一下方向标就改一次，并且记住「这一句」的更正 —— 只活在这个进程里，不落盘。
 * 落盘会让一次手滑永久生效，而下一次开局想换方向时又没有任何地方能提醒你曾经改过。
 *
 * 纯函数 + 一份模块内状态：不读写文件、不连模型，探针和面板都走这里。
 */
import type { TranslateDirection } from './ipc'

/** 逐行判出来的方向，永远不含 `auto-zh`：那个值是「让模型自己认」，这里要的是明确结论。 */
export type DetectedDirection = 'zh-en' | 'en-zh'

/** 汉字占比达到这个数就按中文行算。中英混排里夹英文单词时不会翻错方向，见文件头。 */
export const HAN_SHARE_FOR_ZH_EN = 0.3

const HAN = /[\u3400-\u9fff]/gu
const LATIN = /[A-Za-z]/g

/** 汉字占（汉字 + 拉丁字母）的比例；一个可数的字都没有时算 0。 */
export function hanShare(text: string): number {
  const han = text.match(HAN)?.length ?? 0
  const latin = text.match(LATIN)?.length ?? 0
  const total = han + latin
  return total === 0 ? 0 : han / total
}

/** 只看这一句本身：汉字够多就是中→英（英→中），否则反过来。 */
export function detectDirection(text: string): DetectedDirection {
  return hanShare(text) >= HAN_SHARE_FOR_ZH_EN ? 'zh-en' : 'en-zh'
}

/**
 * 会话级的「这一句该往哪翻」更正表。键是压平过空白的原文 ——
 * 聊天行里同一个意思常常多带一个空格，按原样当键会记不上。
 */
const overrides = new Map<string, DetectedDirection>()

function keyOf(text: string): string {
  return text.replace(/\s+/gu, ' ').trim().toLowerCase()
}

/** 真的决定方向的那一个入口：有更正用更正，没有才按字符占比判。 */
export function directionFor(text: string): DetectedDirection {
  return overrides.get(keyOf(text)) ?? detectDirection(text)
}

/** 记住「这一句」的更正；同一个键再更正就以最后一次为准。 */
export function correctDirection(text: string, direction: DetectedDirection): void {
  const key = keyOf(text)
  if (key.length === 0) return
  if (direction === detectDirection(text)) overrides.delete(key)
  else overrides.set(key, direction)
}

/** 这一句被手工改过方向吗：面板要能说清「为什么这句翻了另一个方向」。 */
export function hasDirectionOverride(text: string): boolean {
  return overrides.has(keyOf(text))
}

/** 会话里被改过方向的句数。 */
export function directionOverrideCount(): number {
  return overrides.size
}

/** 忘掉全部更正（换 provider、换一局时由调用方按需清）。 */
export function forgetDirections(): void {
  overrides.clear()
}

/** 面板与浮层上的字：不写 `auto`，因为这里从来不是「自动」。 */
export function directionLabel(direction: TranslateDirection): string {
  if (direction === 'zh-en') return '中→英'
  if (direction === 'en-zh') return '英→中'
  return '自动'
}
