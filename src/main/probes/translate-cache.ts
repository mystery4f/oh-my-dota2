import { app } from 'electron'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import {
  clearTranslationCache,
  providerKey,
  sameText,
  sessionPaths,
  translateLines
} from '../services/session/durable-translator'
import { inspectTranslationCache } from '../services/session/observe'
import {
  closeTranslationCache,
  clearTranslationPairs,
  lookupTranslation,
  readTranslation,
  translationCachePath,
  translationCachePairsFor,
  translationCacheSize,
  translationCacheStats,
  translationCacheRows,
  translationInsights,
  writeTranslation
} from '../services/session/translate-cache'

/** 探针专用 provider 键：不碰真实模型已经攒下的行。 */
const PROBE = 'probe-provider'

export async function runTranslateCacheProbe(): Promise<void> {
  const checks: { name: string; ok: boolean; detail?: string }[] = []
  const add = (name: string, ok: boolean, detail?: string): void => {
    checks.push(detail === undefined ? { name, ok } : { name, ok, detail })
  }

  writeTranslation('你好', PROBE, 'terse', 'hello', { direction: 'zh-en', origin: 'probe' })
  // 本探针所有行都写 origin='probe'，读取必须带同源调用方（探针之外的人读不到 probe 行）
  add('正向命中', readTranslation('你好', 'zh-en', PROBE, 'terse', 'probe') === 'hello', '你好 → hello')
  // 用户要的那条：自己打过「你好」被译成 hello，之后队友说 hello 就直接出中文
  add(
    '反向命中（目标中文）',
    readTranslation('hello', 'auto-zh', PROBE, 'terse', 'probe') === '你好',
    'hello → 你好，不再调模型'
  )

  writeTranslation('gg wp', PROBE, 'terse', '干得漂亮', { direction: 'auto-zh', origin: 'probe' })
  // 反过来同样成立：屏幕上翻过的英文，自己用中文回复时直接拿
  add(
    '反向命中（目标英文）',
    readTranslation('干得漂亮', 'zh-en', PROBE, 'terse', 'probe') === 'gg wp',
    '干得漂亮 → gg wp'
  )

  // 语言守卫：想翻成英文时，绝不能把中文那一侧当答案交出去
  add('语言守卫', readTranslation('hello', 'zh-en', PROBE, 'terse', 'probe') === null, '中文答案不能冒充英文')
  // 语气只进正向键；反向那半句与语气无关，换语气也该命中
  // 默认开跨语气兜底后，这条不能再断言 null——改成「关掉兜底才隔离」。
  add(
    '语气隔离（关兜底时）',
    readTranslation('你好', 'zh-en', PROBE, 'polite', 'probe', false) === null
  )
  // 跨语气兜底（默认开）：同一句源文换个语气要能直接拿到译文，关掉开关则必须重翻。
  const crossHit = lookupTranslation('你好', 'zh-en', PROBE, 'polite', 'probe')
  add(
    '跨语气兜底（开）',
    crossHit !== null && crossHit.value === 'hello' && crossHit.tone === 'terse',
    JSON.stringify(crossHit)
  )
  add(
    '跨语气兜底（关）',
    lookupTranslation('你好', 'zh-en', PROBE, 'polite', 'probe', false) === null
  )
  add('语气无关（反向）', readTranslation('hello', 'auto-zh', PROBE, 'polite', 'probe') === '你好')
  // 空白容忍：键按归一化后的文本算
  add('空白容忍', readTranslation('  你好  ', 'zh-en', PROBE, 'terse', 'probe') === 'hello')

  const beforeNoop = translationCacheSize()
  writeTranslation('ok', PROBE, 'terse', 'ok', { direction: 'auto-zh', origin: 'probe' })
  add('原样返回不记账', translationCacheSize() === beforeNoop, `entries=${beforeNoop}`)

  add('落在 sqlite', translationCacheStats().persisted, translationCachePath())
  add('条数', translationCacheSize() >= 2, `entries=${translationCacheSize()}`)
  // 词频统计要用的字段：现在没人读，但历史数据只能当场写下来。
  const rows = translationCacheRows(5)
  const hello = rows.find((row) => row.a_raw === '你好')
  add(
    '统计字段齐全',
    hello !== undefined && hello.direction === 'zh-en' && hello.origin === 'probe',
    `direction=${String(hello?.direction)} origin=${String(hello?.origin)}`
  )
  add(
    '词数按汉字逐字 + 拉丁按空格切',
    hello?.a_words === 2 && hello?.b_words === 1,
    `a_words=${String(hello?.a_words)} b_words=${String(hello?.b_words)}`
  )
  add('字符数', hello?.a_len === 2 && hello?.b_len === 5, `a_len=${String(hello?.a_len)} b_len=${String(hello?.b_len)}`)
  add('命中计数在涨', typeof hello?.hits === 'number' && hello.hits >= 1, `hits=${String(hello?.hits)}`)

  // 浮层要能分清「现翻」和「词库」：translateLines 的 marks 必须明确标出命中行。
  const probeProvider = {
    id: 'ollama' as const,
    baseUrl: 'http://127.0.0.1:1',
    model: 'probe-model',
    authStyle: 'bearer' as const,
    apiKey: 'x'
  }
  // 上一轮探针可能留下同键行（冲突更新不碰 origin），先扫掉再种，保证这个段落自洽
  clearTranslationPairs(providerKey(probeProvider))
  // translateLines 按生产（capture）读：词库命中行必须写 capture 来源，否则生产永远读不到
  writeTranslation('词库命中测试', providerKey(probeProvider), 'terse', 'cache hit', {
    direction: 'zh-en',
    origin: 'capture'
  })
  const marks: boolean[] = []
  const markedLines = await translateLines(probeProvider, ['词库命中测试'], 'zh-en', marks)
  add(
    '标出词库命中',
    marks[0] === true && markedLines[0] === 'cache hit',
    `marks=${JSON.stringify(marks)} line=${String(markedLines[0])}`
  )

  // 模型把原文原样吐回来时不该当成译文（存进账本只会多一条无信息的一对）。
  add(
    '同形不算译文',
    sameText('gg', 'GG') && sameText('??? go', '???  go!') && !sameText('hello', '你好'),
    'gg=GG / ???go=?go / hello!=你好'
  )

  // 关掉句柄再读：验证真的落盘，不是只活在内存里
  closeTranslationCache()
  add('重开后仍在', readTranslation('你好', 'zh-en', PROBE, 'terse', 'probe') === 'hello')

  // M11a：预埋字段要能读出来。探针里不碰模型，数字只证明口径通、不证明流量。
  const insights = translationInsights(3)
  add('统计能读出总对数', insights.pairs > 0, `pairs=${insights.pairs}`)
  add(
    '命中比在 0..1 之间',
    insights.hitRatio >= 0 && insights.hitRatio <= 1,
    `hitRatio=${insights.hitRatio} hits=${insights.hits}`
  )
  add('能按来源分组', Object.keys(insights.origins).length > 0, JSON.stringify(insights.origins))
  add('能取到 top 句', Array.isArray(insights.top) && insights.top.length > 0, `top=${insights.top.length}`)
  add(
    '平均长度是正数',
    insights.averageA >= 0 && insights.averageB >= 0,
    `avgA=${insights.averageA} avgB=${insights.averageB}`
  )

  // ---- 清空缓存（面板两步走的缝）：inspect 数数 → clear 真删，其它 provider 一字节不动 ----
  // 用全新的 provider 当夹具：数字只由这里种下的行决定，不被前面段落与历史残留干扰。
  const clearA = { id: 'ollama' as const, baseUrl: 'http://127.0.0.1:2', model: 'clear-a', authStyle: 'bearer' as const, apiKey: 'a' }
  const clearB = { id: 'ollama' as const, baseUrl: 'http://127.0.0.1:2', model: 'clear-b', authStyle: 'bearer' as const, apiKey: 'b' }
  const keyA = providerKey(clearA)
  const keyB = providerKey(clearB)
  // 先把可能的旧痕迹扫掉（上次探针残留），保证下面的计数是准的
  await clearTranslationCache(clearA)
  await clearTranslationCache(clearB)

  writeTranslation('你好呀', keyA, 'terse', 'hello there', { direction: 'zh-en', origin: 'probe' })
  writeTranslation('撤退', keyA, 'terse', 'fall back', { direction: 'zh-en', origin: 'probe' })
  writeTranslation('打钱', keyA, 'polite', 'push', { direction: 'zh-en', origin: 'probe' })
  writeTranslation('小心', keyB, 'terse', 'be careful', { direction: 'zh-en', origin: 'probe' })
  writeTranslation('撤退', keyB, 'terse', 'fall back', { direction: 'zh-en', origin: 'probe' })

  const pathsA = sessionPaths(clearA)
  const pathsB = sessionPaths(clearB)
  mkdirSync(pathsA.dir, { recursive: true })
  writeFileSync(pathsA.state, JSON.stringify({ 'auto-zh': 1, 'zh-en#terse': 2 }), 'utf8')
  writeFileSync(pathsB.state, JSON.stringify({ 'auto-zh': 7, 'zh-en#terse': 8, 'try#en-zh': 9 }), 'utf8')
  // 会话库塞占位文件：clear 不打开会话库，B 的那份必须原样留着
  writeFileSync(pathsA.db, 'seed-a', 'utf8')
  writeFileSync(pathsB.db, 'seed-b', 'utf8')
  const bytesB = { state: readFileSync(pathsB.state), db: readFileSync(pathsB.db) }

  const counts = inspectTranslationCache(clearA)
  add('inspect 数出记账对', counts.pairs === 3, `pairs=${counts.pairs}`)
  add('inspect 数出会话槽', counts.conversations === 2, `conversations=${counts.conversations}`)

  const cleared = await clearTranslationCache(clearA)
  add('clear 报告删除数', cleared.pairs === 3 && cleared.conversations === 2, JSON.stringify(cleared))
  add('A 的记账对清零', translationCachePairsFor(keyA) === 0, `pairs=${translationCachePairsFor(keyA)}`)
  add('B 的记账对保留', translationCachePairsFor(keyB) === 2, `pairs=${translationCachePairsFor(keyB)}`)
  add('B 的查询仍命中', readTranslation('撤退', 'zh-en', keyB, 'terse', 'probe') === 'fall back')
  add(
    'A 的会话文件已删',
    !existsSync(pathsA.state) && !existsSync(pathsA.db) && !existsSync(`${pathsA.db}-wal`)
  )
  add(
    'B 的文件一字节不动',
    existsSync(pathsB.state) &&
      existsSync(pathsB.db) &&
      bytesB.state.equals(readFileSync(pathsB.state)) &&
      bytesB.db.equals(readFileSync(pathsB.db))
  )
  add('A 无 stale 命中', readTranslation('你好呀', 'zh-en', keyA, 'terse', 'probe') === null)
  // 清空后照常可用：关掉重开，另一家的行还在，清空过的那家能重新写入
  closeTranslationCache()
  add('重开后 B 仍在', readTranslation('撤退', 'zh-en', keyB, 'terse', 'probe') === 'fall back')
  writeTranslation('补一刀', keyA, 'terse', 'last hit', { direction: 'zh-en', origin: 'probe' })
  add('重开后 A 能写入', readTranslation('补一刀', 'zh-en', keyA, 'terse', 'probe') === 'last hit')
  // 收尾：探针夹具不留垃圾在真实数据目录
  const pairsAfter = clearTranslationPairs(keyA)
  await clearTranslationCache(clearA)
  await clearTranslationCache(clearB)
  add('收尾清掉夹具', pairsAfter === 1 && translationCachePairsFor(keyA) === 0, `pairsAfter=${pairsAfter}`)

  // ---- 来源隔离：生产的读永不蹭 try/warm/probe 写下的行（glm 的 bkb→bkg 就藏在 try 行里冒充命中）----
  // 全新 provider 夹具：命中只由这里种下的三行决定。
  const isoA = { id: 'ollama' as const, baseUrl: 'http://127.0.0.1:3', model: 'iso-a', authStyle: 'bearer' as const, apiKey: 'i' }
  const isoKey = providerKey(isoA)
  await clearTranslationCache(isoA)
  writeTranslation('bkb还差200块钱', isoKey, 'terse', 'bkg need 200', { direction: 'zh-en', origin: 'try' })
  writeTranslation('来人啊', isoKey, 'polite', 'help', { direction: 'zh-en', origin: 'warm' })
  writeTranslation('probe only', isoKey, 'terse', 'just probe', { direction: 'zh-en', origin: 'probe' })
  // 生产（capture/reply）读不到 try / warm / probe 的任何一行
  add(
    '生产读不蹭 try 行',
    readTranslation('bkb还差200块钱', 'zh-en', isoKey, 'terse', 'capture') === null &&
      readTranslation('bkb还差200块钱', 'zh-en', isoKey, 'terse', 'reply') === null
  )
  // try 调用方读得到自己作用域的行
  add('try 读自己的行', readTranslation('bkb还差200块钱', 'zh-en', isoKey, 'terse', 'try') === 'bkg need 200')
  add('生产读不蹭 warm 行', readTranslation('来人啊', 'zh-en', isoKey, 'terse', 'capture') === null)
  // 同语气读（polite 行就用 polite 调用方读，正向键带语气）
  add('warm 读自己的行', readTranslation('来人啊', 'zh-en', isoKey, 'polite', 'warm') === 'help')
  // probe 行只有 probe 调用方看得到（try/warm 也拒绝）
  add(
    'probe 行对 try/warm 隐藏',
    readTranslation('probe only', 'zh-en', isoKey, 'terse', 'try') === null &&
      readTranslation('probe only', 'zh-en', isoKey, 'terse', 'warm') === null
  )
  add('probe 读得到 probe 行', readTranslation('probe only', 'zh-en', isoKey, 'terse', 'probe') === 'just probe')
  // 反向查表同一把筛子：capture 反查 miss，try 反查命中
  add(
    '反向读同样过滤',
    readTranslation('bkg need 200', 'auto-zh', isoKey, 'terse', 'capture') === null &&
      readTranslation('bkg need 200', 'auto-zh', isoKey, 'terse', 'try') === 'bkb还差200块钱'
  )
  // 跨语气兜底同样过滤：capture 跨语气 miss，try 跨语气拿到 polite 行
  add(
    '跨语气读同样过滤',
    lookupTranslation('来人啊', 'zh-en', isoKey, 'terse', 'capture') === null &&
      lookupTranslation('来人啊', 'zh-en', isoKey, 'terse', 'try')?.value === 'help'
  )
  // 收尾：隔离夹具不留垃圾
  await clearTranslationCache(isoA)
  add('来源隔离夹具清掉', translationCachePairsFor(isoKey) === 0)

  const failed = checks.filter((item) => !item.ok)
  console.log(
    'TRANSLATE_CACHE_PROBE',
    JSON.stringify({ ok: failed.length === 0, passed: checks.length - failed.length, failed: failed.length })
  )
  for (const item of checks) {
    console.log(`  ${item.ok ? 'ok  ' : 'FAIL'} ${item.name}${item.detail ? `  (${item.detail})` : ''}`)
  }
  console.log('TRANSLATE_CACHE_STATS', JSON.stringify(insights))
  for (const row of insights.top) {
    console.log(`  top ${row.hits}× [${row.origin}/${row.direction}] ${row.a} → ${row.b}`)
  }
  app.exit(failed.length === 0 ? 0 : 1)
}
