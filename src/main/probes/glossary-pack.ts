/**
 * 词表包探针（#82）：钉住票面的三条验收线，外加换表时三张派生表必须跟着走。
 *
 * - 一个新英雄的包两个方向都能对上（中文名 + 英文整词）；
 * - 坏包整包拒绝、回退内置，原因留在 status 里（面板就靠它画警告）；
 * - 现役包名可见，面板一行的文案随状态变。
 *
 * 只用纯缝与内存装配：探针不往真实数据目录写词表包（#126 的教训——探针不许碰真文件）。
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { KEEP_VERBATIM_TOKENS, glossaryFor, setGlossaryEntries } from '@shared/dota-glossary'
import {
  bundledGlossaryStatus,
  glossaryPackLine,
  glossaryStatusOf,
  parseGlossaryPack
} from '@shared/glossary-pack'
import { flagKeyNouns, keyNounsOf } from '@shared/key-nouns'
import { applyGlossaryPackName, glossaryPackStatus, setGlossaryDirForProbe } from '../services/glossary-pack'
import { finishProbe, probeCases } from './harness'

const PACK = {
  name: '演示词表',
  entries: [
    { en: 'New Hero', zh: '新英雄', kind: 'hero' },
    { en: 'ww', zh: '怪杖', kind: 'item', keepVerbatim: true },
    { en: 'New Hero', zh: '新英雄', kind: 'hero' }
  ]
}

export async function runGlossaryPackProbe(): Promise<void> {
  const { cases, push: check } = probeCases()

  // —— 校验：合法包与去重 ——
  const parsed = parseGlossaryPack(PACK)
  check('合法包通过校验', parsed.ok === true)
  if (!parsed.ok) {
    finishProbe('GLOSSARY_PACK_PROBE', cases)
    return
  }
  check(
    '重复的 en 只留第一条（整词匹配，重复只会重复命中）',
    parsed.pack.entries.length === 2 && parsed.pack.entries[0].zh === '新英雄',
    `entries=${parsed.pack.entries.length}`
  )
  check('包名原样带回', parsed.pack.name === '演示词表', parsed.pack.name)

  // —— 校验：坏包都要说清哪一条坏了 ——
  const badName = parseGlossaryPack({ entries: [] })
  check('缺 name 被拒', badName.ok === false && badName.error.includes('name'), badName.ok ? '' : badName.error)
  const badEmpty = parseGlossaryPack({ name: '空包', entries: [] })
  check('空 entries 被拒', badEmpty.ok === false && badEmpty.error.includes('entries'), badEmpty.ok ? '' : badEmpty.error)
  const badZh = parseGlossaryPack({ name: '缺中文', entries: [{ en: 'x', kind: 'hero' }] })
  check(
    '缺 zh 的那一条被点名',
    badZh.ok === false && badZh.error.includes('第 1 条') && badZh.error.includes('zh'),
    badZh.ok ? '' : badZh.error
  )
  const badKind = parseGlossaryPack({ name: '坏种类', entries: [{ en: 'x', zh: '叉', kind: 'spell' }] })
  check('kind 不在三类里被拒', badKind.ok === false && badKind.error.includes('kind'), badKind.ok ? '' : badKind.error)
  const badKeep = parseGlossaryPack({ name: '坏布尔', entries: [{ en: 'x', zh: '叉', kind: 'item', keepVerbatim: 'yes' }] })
  check('keepVerbatim 不是布尔被拒', badKeep.ok === false && badKeep.error.includes('keepVerbatim'), badKeep.ok ? '' : badKeep.error)
  const longName = parseGlossaryPack({ name: 'x'.repeat(40), entries: [{ en: 'x', zh: '叉', kind: 'item' }] })
  check('包名太长被拒', longName.ok === false && longName.error.includes('太长'), longName.ok ? '' : longName.error)

  // —— 装上新表：新英雄两个方向都命中（票面第一条验收） ——
  setGlossaryEntries(parsed.pack.entries)
  const byZh = glossaryFor('新英雄在中路', 'zh-en')
  const byEn = glossaryFor('new hero mid', 'en-zh')
  check(
    '新英雄：中文侧命中',
    byZh.length === 1 && byZh[0].zh === '新英雄' && byZh[0].en === 'New Hero',
    JSON.stringify(byZh.map((entry) => entry.en))
  )
  check(
    '新英雄：英文整词命中（方向不影响匹配）',
    byEn.length === 1 && byEn[0].zh === '新英雄',
    JSON.stringify(byEn.map((entry) => entry.zh))
  )
  check('包外的词条不再现役（换表不是合并）', glossaryFor('需要跳刀', 'zh-en').length === 0)

  // —— 换表后派生表跟着走：keepVerbatim 与关键名词 ——
  check('包里的 keepVerbatim 进了保真 token 表', KEEP_VERBATIM_TOKENS.has('ww'))
  // 方向 = 翻译方向，不是文本语言：中文原文走 zh-en 那一侧（auto-zh 交给英文整词匹配）。
  const nouns = keyNounsOf('新英雄来了', 'zh-en')
  check('关键名词清单换成包里的表', nouns.length === 1 && nouns[0].zh === '新英雄', JSON.stringify(nouns))
  const flagged = flagKeyNouns(nouns, '有人来了')
  check('译文丢了新英雄就被点名', flagged.keyNouns.join(',') === '新英雄' && flagged.text === '有人来了', flagged.keyNouns.join(','))

  // —— 回退：装不上就是内置表，原因留着 ——
  const missing = applyGlossaryPackName('不存在的包')
  check(
    '找不到包：回退内置并说明找不到',
    missing.source === 'bundled' && missing.error !== null && missing.error.includes('找不到'),
    String(missing.error)
  )
  check('回退后内置词表重新生效', glossaryFor('需要跳刀', 'zh-en').length === 1)
  check('回退后包里的词条退场', glossaryFor('新英雄来了', 'zh-en').length === 0)
  check('回退后保真 token 表也回到内置', !KEEP_VERBATIM_TOKENS.has('ww') && KEEP_VERBATIM_TOKENS.has('bkb'))

  // —— 现役名字可见（票面第三条验收）：status 与面板那一行 ——
  const packStatus = glossaryStatusOf(parsed.pack, '演示词表.json', ['演示词表', '坏包'])
  check(
    '装上时：名字、条数、文件名都在',
    packStatus.name === '演示词表' && packStatus.entries === 2 && packStatus.file === '演示词表.json',
    JSON.stringify(packStatus)
  )
  check('装上时的面板文案说出名字与条数', glossaryPackLine(packStatus).includes('演示词表') && glossaryPackLine(packStatus).includes('2 条'), glossaryPackLine(packStatus))
  const fallbackLine = glossaryPackLine(bundledGlossaryStatus('坏了', ['坏包'], '坏包.json'))
  check(
    '坏包时面板文案同时说「回退内置」和原因',
    fallbackLine.includes('内置') && fallbackLine.includes('已回退内置') && fallbackLine.includes('坏了'),
    fallbackLine
  )
  const emptyLine = glossaryPackLine(bundledGlossaryStatus())
  check(
    '没有包时文案说清去哪里放',
    emptyLine.includes('内置') && emptyLine.includes('还没有词表包'),
    emptyLine
  )

  // —— 运行中丢一个包进目录（#141）：清单必须现扫，不能是开机那次的缓存 ——
  const tmpDir = mkdtempSync(join(tmpdir(), 'glossary-pack-'))
  setGlossaryDirForProbe(tmpDir)
  const empty = glossaryPackStatus()
  check('空目录：一个包都没有', empty.available.length === 0, JSON.stringify(empty.available))
  writeFileSync(join(tmpDir, '我的词表.json'), JSON.stringify({ name: '我的词表', entries: [{ en: 'aa', zh: '啊啊', kind: 'item' }] }))
  const afterDrop = glossaryPackStatus()
  check('放进目录后立刻出现在清单里（不重启）', afterDrop.available.join(',') === '我的词表', JSON.stringify(afterDrop.available))
  const installed = applyGlossaryPackName('我的词表')
  check(
    '现扫到的包真能装上',
    installed.source === 'pack' && installed.name === '我的词表' && installed.entries === 1,
    JSON.stringify(installed)
  )
  rmSync(join(tmpDir, '我的词表.json'))
  const afterRemove = glossaryPackStatus()
  check('删掉之后从清单里消失', afterRemove.available.length === 0, JSON.stringify(afterRemove.available))
  setGlossaryDirForProbe(null)
  rmSync(tmpDir, { recursive: true, force: true })

  setGlossaryEntries(null)
  finishProbe('GLOSSARY_PACK_PROBE', cases)
}
