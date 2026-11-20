/**
 * 逐行判方向（#84）：纯中文、纯英文、混排三种行各判到该去的方向，
 * 手工更正只改「这一句」并且在这一局里一直生效。
 *
 * 探针不连模型也不碰文件：`@shared/translate-direction` 是纯函数加一份模块内状态。
 */
import {
  HAN_SHARE_FOR_ZH_EN,
  correctDirection,
  detectDirection,
  directionFor,
  directionLabel,
  directionOverrideCount,
  forgetDirections,
  hanShare,
  hasDirectionOverride
} from '@shared/translate-direction'
import { finishProbe, probeCases } from './harness'

export async function runTranslateDirectionProbe(): Promise<void> {
  const { cases, push: check } = probeCases()

  // ---- 票面第一条：三种行各判到该去的方向 ----
  check('纯英文判成英→中', detectDirection('where is the courier') === 'en-zh', detectDirection('where is the courier'))
  check('纯中文判成中→英', detectDirection('中路不见了') === 'zh-en', detectDirection('中路不见了'))
  check('中英混排夹中文词：按中文行算', detectDirection('push 中路') === 'zh-en', detectDirection('push 中路'))
  check(
    '混排但以英文为主：按英文行算',
    detectDirection('where is the 肉山') === 'en-zh',
    detectDirection('where is the 肉山')
  )

  // ---- 分母只数汉字与字母：数字、标点、表情不许把比例带偏 ----
  check('数字与标点不进分母：GG 666 是英文行', detectDirection('GG 666') === 'en-zh', detectDirection('GG 666'))
  check('纯符号没有可数的字：比例算 0', hanShare('？！…') === 0, String(hanShare('？！…')))
  check(
    `阈值就在 ${HAN_SHARE_FOR_ZH_EN}：一个字长两字的行按中文算`,
    hanShare('gg 打野') > HAN_SHARE_FOR_ZH_EN && detectDirection('gg 打野') === 'zh-en',
    String(hanShare('gg 打野'))
  )

  // ---- 票面第二条：手工更正只改这一句，并且在这一局里一直生效 ----
  forgetDirections()
  check('还没人更正时按自己判', directionFor('need mjollnir') === 'en-zh', directionFor('need mjollnir'))
  correctDirection('need mjollnir', 'zh-en')
  check('更正之后这一句改判成中→英', directionFor('need mjollnir') === 'zh-en', directionFor('need mjollnir'))
  check(
    '换一下空白与大小写也认得出是同一句',
    directionFor('  Need   Mjollnir ') === 'zh-en',
    directionFor('  Need   Mjollnir ')
  )
  check('别的句子不受影响', directionFor('where is the courier') === 'en-zh', directionFor('where is the courier'))
  check('更正过得能查出来：面板要说清为什么翻了另一个方向', hasDirectionOverride('need mjollnir'))
  check('更正条数是准数', directionOverrideCount() === 1, String(directionOverrideCount()))
  correctDirection('need mjollnir', 'en-zh')
  check(
    '再更正回它自己判的那个方向：更正被撤掉，不留下一条空记录',
    directionOverrideCount() === 0 && !hasDirectionOverride('need mjollnir'),
    String(directionOverrideCount())
  )
  correctDirection('', 'zh-en')
  check('空句子记不上更正', directionOverrideCount() === 0, String(directionOverrideCount()))
  correctDirection('中路不见了', 'en-zh')
  forgetDirections()
  check('清掉之后一句话都不记得了', directionOverrideCount() === 0 && directionFor('中路不见了') === 'zh-en')

  // ---- 给面板与浮层的字 ----
  check('方向标写的是中→英 / 英→中', directionLabel('zh-en') === '中→英' && directionLabel('en-zh') === '英→中')

  finishProbe('TRANSLATE_DIRECTION_PROBE', cases)
}
