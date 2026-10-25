import { app } from 'electron'
import { providerKey, sameText, translateLines } from '../services/session/durable-translator'
import {
  closeTranslationCache,
  lookupTranslation,
  readTranslation,
  translationCachePath,
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
  // 正向：同一句话同一方向，翻过就不再翻
  add('正向命中', readTranslation('你好', 'zh-en', PROBE, 'terse') === 'hello', '你好 → hello')
  // 用户要的那条：自己打过「你好」被译成 hello，之后队友说 hello 就直接出中文
  add(
    '反向命中（目标中文）',
    readTranslation('hello', 'auto-zh', PROBE, 'terse') === '你好',
    'hello → 你好，不再调模型'
  )

  writeTranslation('gg wp', PROBE, 'terse', '干得漂亮', { direction: 'auto-zh', origin: 'probe' })
  // 反过来同样成立：屏幕上翻过的英文，自己用中文回复时直接拿
  add(
    '反向命中（目标英文）',
    readTranslation('干得漂亮', 'zh-en', PROBE, 'terse') === 'gg wp',
    '干得漂亮 → gg wp'
  )

  // 语言守卫：想翻成英文时，绝不能把中文那一侧当答案交出去
  add('语言守卫', readTranslation('hello', 'zh-en', PROBE, 'terse') === null, '中文答案不能冒充英文')
  // 语气只进正向键；反向那半句与语气无关，换语气也该命中
  // 默认开跨语气兜底后，这条不能再断言 null——改成「关掉兜底才隔离」。
  add(
    '语气隔离（关兜底时）',
    readTranslation('你好', 'zh-en', PROBE, 'polite', 'probe', false) === null
  )
  // 跨语气兜底（默认开）：同一句源文换个语气要能直接拿到译文，关掉开关则必须重翻。
  const crossHit = lookupTranslation('你好', 'zh-en', PROBE, 'polite')
  add(
    '跨语气兜底（开）',
    crossHit !== null && crossHit.value === 'hello' && crossHit.tone === 'terse',
    JSON.stringify(crossHit)
  )
  add(
    '跨语气兜底（关）',
    lookupTranslation('你好', 'zh-en', PROBE, 'polite', 'capture', false) === null
  )
  add('语气无关（反向）', readTranslation('hello', 'auto-zh', PROBE, 'polite') === '你好')
  // 空白容忍：键按归一化后的文本算
  add('空白容忍', readTranslation('  你好  ', 'zh-en', PROBE, 'terse') === 'hello')

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
  writeTranslation('词库命中测试', providerKey(probeProvider), 'terse', 'cache hit', {
    direction: 'zh-en',
    origin: 'probe'
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
  add('重开后仍在', readTranslation('你好', 'zh-en', PROBE, 'terse') === 'hello')

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
