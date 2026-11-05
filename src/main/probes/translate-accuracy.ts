/**
 * 翻译准确度包的纯决策缝，零网络零模型零窗口：
 * - @shared/dota-glossary：双向词表的检索（两侧同匹配、词边界、上限）、提示词块、保真词表一致性
 * - @shared/translate-fidelity：拉丁 token 保真守卫（zh-en 全查，en-zh 只盯 keep 词表）
 * - instructionsFor / SYSTEM_PROMPTS：词表块真的进了两个方向的系统指令，散文措辞与词表同步
 */
import { app } from 'electron'
import {
  GLOSSARY,
  glossaryFor,
  glossaryPromptBlock,
  JARGON_KEEP_TOKENS,
  KEEP_VERBATIM_TOKENS
} from '@shared/dota-glossary'
import { latinTokenViolations } from '@shared/translate-fidelity'
import { SYSTEM_PROMPTS } from '../services/providers'
import { instructionsFor } from '../services/session/durable-translator'

const deepEqualJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export async function runTranslateAccuracyProbe(): Promise<void> {
  const checks: { name: string; ok: boolean; detail?: string }[] = []
  const add = (name: string, ok: boolean, detail?: string): void => {
    checks.push(detail === undefined ? { name, ok } : { name, ok, detail })
  }

  // ---- 词表本体：数量、唯一性、类别、keepVerbatim 词条必须是短缩写 ----
  add('词表规模 60-90', GLOSSARY.length >= 60 && GLOSSARY.length <= 90, `entries=${GLOSSARY.length}`)
  const enSet = new Set(GLOSSARY.map((entry) => entry.en.toLowerCase()))
  add('en 侧唯一', enSet.size === GLOSSARY.length, `unique=${enSet.size}`)
  add(
    '类别合法且两侧非空',
    GLOSSARY.every(
      (entry) =>
        (entry.kind === 'hero' || entry.kind === 'item' || entry.kind === 'jargon') &&
        entry.zh.trim() !== '' &&
        entry.en.trim() !== ''
    )
  )
  add(
    'keepVerbatim 词条都是短缩写',
    GLOSSARY.filter((entry) => entry.keepVerbatim === true).every((entry) => /^[a-z0-9]+$/i.test(entry.en)),
    GLOSSARY.filter((entry) => entry.keepVerbatim === true)
      .map((entry) => entry.en)
      .join(',')
  )
  // 保真词表与词表条目同步：keepVerbatim 的每个 token 都必须在 KEEP_VERBATIM_TOKENS 里
  const keepTokenMissing = GLOSSARY.filter((entry) => entry.keepVerbatim === true)
    .flatMap((entry) => entry.en.toLowerCase().match(/[a-z0-9]+/g) ?? [])
    .filter((token) => !KEEP_VERBATIM_TOKENS.has(token))
  add('保真词表含全部 keepVerbatim token', keepTokenMissing.length === 0, keepTokenMissing.join(','))
  add('保真词表含 JARGON_KEEP 全表', JARGON_KEEP_TOKENS.every((token) => KEEP_VERBATIM_TOKENS.has(token)))

  // ---- glossaryFor：两侧同匹配（中文侧子串、英文侧词边界）、大小写不敏感、上限 ----
  const blueCat = glossaryFor('蓝猫来中路', 'zh-en')
  add(
    'CN 行命中英雄条目',
    blueCat.some((entry) => entry.en === 'Storm Spirit' && entry.zh === '蓝猫' && entry.kind === 'hero')
  )
  const storm = glossaryFor('storm spirit missing', 'en-zh')
  add(
    'EN 行命中 EN 侧',
    storm.some((entry) => entry.en === 'Storm Spirit') && storm.every((entry) => entry.en !== 'ss'),
    'missing 不得命中 ss'
  )
  const bkbLine = glossaryFor('bkb还差200块钱', 'zh-en')
  add(
    '混排行命中缩写（动机案例）',
    bkbLine.length === 1 && bkbLine[0].en === 'bkb' && bkbLine[0].keepVerbatim === true,
    JSON.stringify(bkbLine.map((entry) => entry.en))
  )
  add(
    '大小写不敏感',
    glossaryFor('BKB NEED 200', 'en-zh').some((entry) => entry.en === 'bkb') &&
      glossaryFor('ROSH or feed', 'en-zh').some((entry) => entry.en === 'rosh')
  )
  add(
    '词边界：nod 不命中 od，missing 不命中 ss',
    glossaryFor('nod plz', 'en-zh').length === 0 && !glossaryFor('missing', 'en-zh').some((entry) => entry.en === 'ss')
  )
  const crowded =
    '蓝猫 火猫 土猫 小黑 敌法 白虎 大娜迦 小娜迦 人马 潮汐 大鱼 小鱼 拍拍 黑鸟 蓝胖 冰女'
  add(
    '上限 12 条',
    glossaryFor(crowded, 'zh-en').length === 12 && glossaryFor(crowded, 'zh-en', 3).length === 3,
    `default=${glossaryFor(crowded, 'zh-en').length}`
  )
  // 顺序跟随 GLOSSARY 声明顺序（同一个 prompt 排版每次一致）
  const ordered = glossaryFor(crowded, 'zh-en')
  add(
    '确定性顺序（按声明顺序返回）',
    ordered[0].en === 'Storm Spirit' && ordered[1].en === 'Ember Spirit' && ordered[2].en === 'Earth Spirit'
  )

  // ---- latinTokenViolations：zh-en 全查（拉丁 token + 数字），en-zh/auto-zh 只查 keep 词表 ----
  add(
    '动机案例：bkb 写坏成 bkg',
    deepEqualJson(latinTokenViolations('bkb还差200块钱', 'bkg need 200', 'zh-en'), ['bkb']),
    JSON.stringify(latinTokenViolations('bkb还差200块钱', 'bkg need 200', 'zh-en'))
  )
  add(
    '数字被吞',
    deepEqualJson(latinTokenViolations('5人推中', 'push mid together', 'zh-en'), ['5']) &&
      latinTokenViolations('bkb还差200块钱', 'wait bkb 200 gold short', 'zh-en').length === 0
  )
  add(
    '多个 token 只丢一个也能报出来',
    deepEqualJson(latinTokenViolations('bkb和tp好了', 'bkb ready', 'zh-en'), ['tp'])
  )
  add(
    '大小写不敏感判通过',
    latinTokenViolations('BKB GO', 'bkb go now', 'zh-en').length === 0
  )
  add(
    'zh-en 强制全部拉丁 token',
    deepEqualJson(latinTokenViolations('mid hp low', '中路没血', 'zh-en'), ['mid', 'hp', 'low']),
    JSON.stringify(latinTokenViolations('mid hp low', '中路没血', 'zh-en'))
  )
  add(
    'en-zh keep 词被译成中文',
    deepEqualJson(latinTokenViolations('bkb is ready', '黑皇杖好了', 'en-zh'), ['bkb']),
    JSON.stringify(latinTokenViolations('bkb is ready', '黑皇杖好了', 'en-zh'))
  )
  add(
    'en-zh 非 keep 词不强制',
    latinTokenViolations('hello team', '喂 队伍', 'en-zh').length === 0 &&
      latinTokenViolations('heart', '龙心', 'en-zh').length === 0
  )
  add('en-zh keep 词存活即通过', latinTokenViolations('gg wp', 'gg wp', 'en-zh').length === 0)
  add('auto-zh 同 en-zh 规则', deepEqualJson(latinTokenViolations('gg', '干得漂亮', 'auto-zh'), ['gg']))
  add(
    '空译文全报',
    deepEqualJson(latinTokenViolations('bkb还差200块钱', '', 'zh-en'), ['bkb', '200'])
  )

  // ---- instructionsFor：词表块进了两个方向的会话指令 ----
  const zhEnInstructions = instructionsFor('zh-en', 'terse')
  add(
    'zh-en 指令含词表块',
    zhEnInstructions.includes('- 蓝猫 = Storm Spirit') &&
      zhEnInstructions.includes('- 黑皇杖 = keep as bkb') &&
      zhEnInstructions.includes('- 黑鸟 = keep as od') &&
      zhEnInstructions.includes('Always keep verbatim:')
  )
  add(
    'zh-en 指令仍带基础提示词与编号契约',
    zhEnInstructions.includes('You turn one Chinese Dota 2 in-game message') &&
      zhEnInstructions.includes('"1| text"')
  )
  const enZhInstructions = instructionsFor('en-zh')
  add(
    'en-zh 指令含词表块',
    enZhInstructions.includes('- Storm Spirit = 蓝猫') &&
      enZhInstructions.includes('- bkb = keep as bkb') &&
      enZhInstructions.includes('Always keep verbatim:')
  )
  const promptBlock = glossaryPromptBlock('zh-en')
  add(
    '词表块行数与词表一致',
    promptBlock.split('\n').filter((line) => line.startsWith('- ') && !line.startsWith('- Always')).length ===
      GLOSSARY.length,
    `lines=${promptBlock.split('\n').filter((line) => line.startsWith('- ') && !line.startsWith('- Always')).length}`
  )

  // ---- SYSTEM_PROMPTS：新措辞 + JARGON_KEEP 扩表 + 保真词表与散文同步 ----
  add(
    'en-zh 措辞：glossary + CN slang + 缩写进 JARGON_KEEP',
    SYSTEM_PROMPTS['en-zh'].includes('glossary block') &&
      SYSTEM_PROMPTS['en-zh'].includes('CN slang') &&
      SYSTEM_PROMPTS['en-zh'].includes('bkb') &&
      SYSTEM_PROMPTS['en-zh'].includes('mkb') &&
      SYSTEM_PROMPTS['en-zh'].includes('od, linken')
  )
  add(
    'zh-en 措辞：CN 黑话映射 + 缩写原样',
    SYSTEM_PROMPTS['zh-en'].includes('glossary block') &&
      SYSTEM_PROMPTS['zh-en'].includes('CN hero slang') &&
      SYSTEM_PROMPTS['zh-en'].includes('stay verbatim') &&
      SYSTEM_PROMPTS['zh-en'].includes('bkb')
  )
  add('auto-zh 措辞同步', SYSTEM_PROMPTS['auto-zh'].includes('glossary block'))
  // 旧措辞必须消失：不再有「一律原样保留英雄名」的行
  add(
    '旧措辞已移除',
    !SYSTEM_PROMPTS['en-zh'].includes('Keep hero names, item names, player nicknames') &&
      !SYSTEM_PROMPTS['auto-zh'].includes('Keep hero names, item names, player nicknames') &&
      !SYSTEM_PROMPTS['zh-en'].includes('hero names, item names, player nicknames')
  )
  const keepOutOfPrompt = Array.from(KEEP_VERBATIM_TOKENS).filter(
    (token) => !new RegExp(`\\b${token}\\b`, 'i').test(SYSTEM_PROMPTS['en-zh'])
  )
  add(
    '保真词表每个 token 都在提示词散文里',
    keepOutOfPrompt.length === 0,
    keepOutOfPrompt.join(',')
  )

  const failed = checks.filter((item) => !item.ok)
  console.log(
    'TRANSLATE_ACCURACY_PROBE',
    JSON.stringify({ ok: failed.length === 0, passed: checks.length - failed.length, failed: failed.length })
  )
  for (const item of checks) {
    console.log(`  ${item.ok ? 'ok  ' : 'FAIL'} ${item.name}${item.detail ? `  (${item.detail})` : ''}`)
  }
  app.exit(failed.length === 0 ? 0 : 1)
}
