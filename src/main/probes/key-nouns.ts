/**
 * 关键名词探针（#83）：纯判定，不连模型、不读写文件。
 *
 * 锁三条（票面验收线）：
 * - 译文丢掉源文点名的物品/英雄名时，正好标一次（同一个名词不重复标）；
 * - 干净的译文一条都不标，术语（mid/top）和词边界内的假命中都不算名词；
 * - 标记永远不改译文：`flagKeyNouns` 返回的 text 与传进去的一字不差。
 *
 * 再加两条方向约定：zh-en 的中文名从英文译文里消失要标；英文原名留在译文里也算没丢。
 */
import { flagKeyNouns, keyNounsOf, type KeyNoun } from '@shared/key-nouns'
import { finishProbe, probeCases } from './harness'

/** 翻译前的那一次比对：把源文点名的名词抽成清单（翻译后只用它核对）。 */
function nounsOf(source: string, direction: 'zh-en' | 'auto-zh' = 'auto-zh'): KeyNoun[] {
  return keyNounsOf(source, direction)
}
function flagsOf(source: string, target: string, direction: 'zh-en' | 'auto-zh' = 'auto-zh'): string[] {
  return flagKeyNouns(nounsOf(source, direction), target).keyNouns
}

export async function runKeyNounProbe(): Promise<void> {
  const { cases, push: check } = probeCases()

  // ---- 票面第一条：丢掉的物品名标一次 ----
  const removed = flagKeyNouns(nounsOf('need mjollnir top'), '需要上路')
  check(
    '丢掉物品名：只标一次，且点的是中文名',
    removed.keyNouns.length === 1 && removed.keyNouns[0] === '雷锤',
    JSON.stringify(removed.keyNouns)
  )
  check('标记不改译文：返回的 text 与传进去的一字不差', removed.text === '需要上路', removed.text)

  // ---- 票面第二条：干净译文不标 ----
  check('干净的译文一条都不标', flagsOf('need mjollnir top', '需要雷锤上路').length === 0, flagsOf('need mjollnir top', '需要雷锤上路').join(','))
  check(
    '英文原名留在译文里也算没丢',
    flagsOf('need mjollnir top', 'mjollnir 上路').length === 0,
    flagsOf('need mjollnir top', 'mjollnir 上路').join(',')
  )

  // ---- 方向：zh-en 的中文名从英文译文里整体消失才标 ----
  check('zh-en 丢了英雄名要标', flagsOf('雷锤还没出', 'not ready', 'zh-en').join(',') === '雷锤', flagsOf('雷锤还没出', 'not ready', 'zh-en').join(','))
  check(
    'zh-en 译文带着原缩写算没丢',
    flagsOf('雷锤还没出', 'mjollnir not ready', 'zh-en').length === 0,
    flagsOf('雷锤还没出', 'mjollnir not ready', 'zh-en').join(',')
  )

  // ---- 不重复标：同一名词出现两次只标一次 ----
  check('同一个名词重复出现只标一次', flagsOf('mjollnir mjollnir go', '上路').join(',') === '雷锤', flagsOf('mjollnir mjollnir go', '上路').join(','))

  // ---- 不是关键名词：术语与词边界假命中 ----
  check('术语（mid/top/push）不算关键名词', nounsOf('push mid now').length === 0, JSON.stringify(nounsOf('push mid now')))
  check('词边界：tinyhouse 不得命中英雄 tiny', nounsOf('tinyhouse next door').length === 0, JSON.stringify(nounsOf('tinyhouse next door')))
  check('英雄 tiny 被点名时清单里只有它自己', nounsOf('tiny is missing').map((noun) => noun.zh).join(',') === '小小', nounsOf('tiny is missing').map((noun) => noun.zh).join(','))

  // ---- 短名英雄也参与（od → 黑鸟），中文译文丢掉黑鸟要标 ----
  check(
    'od 点名、中文译文没提黑鸟：标一次',
    flagsOf('od mid', '中单不见了').join(',') === '黑鸟',
    flagsOf('od mid', '中单不见了').join(',')
  )

  // ---- 多个名词各标一次 ----
  check(
    '两个名词都丢了就各标一次',
    flagsOf('storm spirit blink dagger', '不见了').join(',') === '蓝猫,跳刀',
    flagsOf('storm spirit blink dagger', '不见了').join(',')
  )
  check(
    '两个名词都在译文里：一条都不标',
    flagsOf('storm spirit blink dagger', '蓝猫跳刀都在').length === 0,
    flagsOf('storm spirit blink dagger', '蓝猫跳刀都在').join(',')
  )

  // ---- 空清单：没有点名就没有核对 ----
  const empty = flagKeyNouns(nounsOf(''), '随便一句话')
  check('源文没点名词：空清单，译文原样', empty.keyNouns.length === 0 && empty.text === '随便一句话', JSON.stringify(empty.keyNouns))

  finishProbe('KEY_NOUN_PROBE', cases)
}
