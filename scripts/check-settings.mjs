#!/usr/bin/env node
/**
 * 设置一致性巡检（#177）。
 *
 * 这个脚本回答三件事，全部是**静态**读源码得出的：
 *
 * - 有没有设置项**写了没人读**（死配置）。历史案例：`quickPhraseGroups`（#159 已删）。
 * - 有没有设置项**改了要重启 / 下次才生效**却没在面板上说清。
 * - 有没有设置项**有两处写口**。
 *
 * 口径是三层，只有前两层参与判定（第三层只作为「反证尝试」记录在案，因为从字面量里认不出引用关系）：
 *
 *   读 · `\.key\b`（后面不是赋值号）        —— `settings.key` / `s.key` / `state.settings.key`
 *   读 · `{ … key … } = settings`           —— 解构
 *   读 · `pick(settings, 'key')`            —— 取值辅助
 *   写 · `update({ key: … })`               —— 面板的写入辅助
 *   写 · `saveSettings({ key: … })`         —— 主进程写盘
 *   写 · `patch({ key: … })`                —— 局部补丁
 *   反证 · 字符串字面量 `'key'` 出现在面板之外、`as any` 附近 3 行内、IPC 文件里同名串
 *
 * 为什么反证不参与判定：动态键拼接（`{ [k]: v }`）、`as any`、IPC 通道字符串都能让一个真有读点的键
 * 在正规读点上为零。所以「读点为零」只是**可疑**，要人工看反证；而「三层全空」才判死配置。
 *
 * 退出码：默认 0，只打印摘要 —— 这条挂在 `npm run lint` 里，一上来就红等于教所有人 `--no-verify`。
 * 只有两类会非零：`AppSettings` 字段与 `DEFAULT_SETTINGS` 键不一致；死配置比基线多一条。
 * `--strict` 把多写口、重启提示缺失、下次生效未声明也变成非零（CI 不启用）。
 *
 * 不写 `data/`、不连 provider、不花任何模型调用：只 `readFileSync`。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHAPE_FILE = 'src/shared/settings-shape.ts'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name) => {
  const hit = args.findIndex((a) => a === name)
  return hit >= 0 ? args[hit + 1] : null
}
const STRICT = flag('--strict')
const REPORT = flag('--report')
const JSON_OUT = flag('--json')
const SETTINGS_PATH = value('--settings')

/**
 * 「改了要重启」的声明表。
 *
 * 只收**必须重启进程 / 必须重启游戏**的键。`reason` 写为什么，`hint` 写今天面板上那句提示在哪儿、
 * 原文是什么 —— 脚本会核对那句话还在不在，所以「提示被删掉」这种事会当场变红。
 */
const RESTART_KEYS = {
  gsiLibraryRoot: {
    reason: 'Dota 只在启动时读 GSI 配置：换库后写的新 cfg 要等游戏重启才被读到',
    hintFile: 'src/renderer/src/panel/pages/overview.tsx',
    hintText: 'Dota 只在启动时读 GSI 配置：换库后要重启游戏才会生效。'
  }
}

/**
 * 「下次才生效」的声明表：不用重启，但也不是立刻。
 *
 * 和「要重启」分开是因为用户要做的动作完全不同：前者什么都不用做，后者得关掉重开。
 */
const NEXT_TIME_KEYS = {
  asrActiveModel: { after: '下一句识别（识别器按需加载，切模型会重载一次图）', hintFile: 'src/renderer/src/panel/pages/asr-train.tsx' },
  ttsEngine: { after: '下一次合成（引擎在合成时才读设置）', hintFile: 'src/renderer/src/panel/pages/read.tsx' },
  asrHotwords: { after: '下一次识别（热词是识别器的构造参数，改了就重载）', hintFile: 'src/renderer/src/panel/pages/asr-train.tsx' }
}

/** 基线：今天的死配置清单。多出一条就红（少一条不红，那是修好了）。 */
const DEAD_BASELINE = []

/**
 * 多写口的人工注记：哪两页、为什么必须两处。
 *
 * 只列不判 —— 脚本不替你决定哪一处该删；「是不是有意」由这张表回答，表外新增的多写口在报告里标「未注记」。
 */
const MULTI_WRITE_NOTES = {
  asrActiveModel:
    '有意：面板选模型（`src/main/services/voice/asr-model.ts:170`）+ 训练成功后自动提为现役（`src/main/services/train/asr-ft.ts:410,525`）；两条都是「切现役」，不是两处改同一个值的冲突',
  myNicknames: '有意：GSI 从聊天里认出的昵称自动追加（`src/main/services/gsi.ts:486`，只留最近 8 个）+ 浮层页手改名单',
  ttsMuteHeroes: '有意：对讲页、朗读页与驾驶室都能改同一个名单（#93 + #168 + #161，用户在哪页都能加人）',
  ttsMuteNames: '同上，按昵称的那半张表（对讲页与朗读页）',
  ttsSovitsRefAudio:
    '有意：音色包页选一个参考音频时三件一起写（`src/renderer/src/panel/pages/packs.tsx:170`），服务端应用整套参考时也写同一组（`src/main/services/voice/sovits-server.ts:233`）',
  ttsSovitsPromptText: '同上：选参考音频时整套写入，音色包页也能单独改这一格',
  ttsSovitsPromptLang: '同上：语言跟着参考音频一起写，面板不给单独编辑',
  ttsDropBacklog:
    '未注记（有意保留两处、是否收归由 pm 定）：同一个开关在朗读页（`read.tsx:374`）与对讲页的设置抽屉（`talk.tsx:882`）各一个；两处都是同一个布尔，改哪边都生效，但用户会看到两个「刷屏积压」开关——是否收归一处由 pm 定，脚本不判'
}

function read(path) {
  return readFileSync(join(ROOT, path), 'utf8')
}

/** 解析 `AppSettings` 的字段：名字 / 是否可选 / 类型文本。 */
function parseFields(source) {
  const body = /export interface AppSettings \{([\s\S]*?)\n\}/.exec(source)
  if (!body) throw new Error(`没找到 AppSettings 接口：${SHAPE_FILE}`)
  const out = []
  for (const line of body[1].split('\n')) {
    const hit = /^'?([A-Za-z0-9_]+)'?(\?)?:\s*(.+?)(?:,)?$/.exec(line.trim())
    if (hit) out.push({ name: hit[1], optional: hit[2] === '?', type: hit[3].trim() })
  }
  return out
}

/** 解析 `DEFAULT_SETTINGS` 的键与默认值原文。 */
/** 嵌套对象/数组在 `DEFAULT_SETTINGS` 里跨行，只抓到开头那个括号：报告里写成 `{ … }`，免得一行表格看不出形状。 */
function plainDefault(value) {
  const first = value.charAt(0)
  if (first === '{') return '{ … }'
  if (first === '[') return '[ … ]'
  return value.length > 40 ? `${value.slice(0, 39)}…` : value
}

function parseDefaults(source) {
  const body = /export const DEFAULT_SETTINGS[^=]*= \{([\s\S]*?)\n\}/.exec(source)
  if (!body) throw new Error(`没找到 DEFAULT_SETTINGS：${SHAPE_FILE}`)
  const out = new Map()
for (const raw of body[1].split('\n')) {
    // 这份仓库的工作副本是 CRLF（`core.autocrlf=true`）：不先去掉行尾的 `\r`，`$` 永远匹配不上。
    // 只认顶层键：`DEFAULT_SETTINGS` 里有嵌套对象（`providerKeys`），按缩进认才不会把嵌套字段当成设置项。
    const hit = /^ {2}([A-Za-z0-9_]+):\s*(.+?),?$/.exec(raw.replace(/\r$/, ''))
    if (hit) out.set(hit[1], plainDefault(hit[2].trim()))
  }
  return out
}

function walkSource() {
  const out = []
  const visit = (dir) => {
    for (const entry of readdirSync(join(ROOT, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'prototype') continue
        visit(rel)
      } else if (/\.(ts|tsx|mjs)$/.test(entry.name)) out.push(rel)
    }
  }
  visit('src')
  for (const entry of readdirSync(join(ROOT, 'scripts'))) {
    if (entry.endsWith('.mjs')) out.push(`scripts/${entry}`)
  }
  return out
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** 三层读点：`.key`、解构、`pick(settings, 'key')`。 */
function countReads(key, file, text) {
  const dots = [...text.matchAll(new RegExp(`\\.${escape(key)}\\b(?!\\s*=[^=])`, 'g'))].length
  const destruct = [...text.matchAll(/\{([^}]*)\}\s*=\s*settings/g)]
    .filter((hit) => new RegExp(`\\b${escape(key)}\\b`).test(hit[1])).length
  const picks = [...text.matchAll(/pick\(\s*settings\s*,\s*'([^']+)'/g)].filter((hit) => hit[1] === key).length
  return { dots, destruct, picks, total: dots + destruct + picks }
}

/** 写点：`update({ … key: … })` / `saveSettings({ … })` / `patch({ … })`。 */
function countWrites(key, text) {
  let count = 0
  const calls = [...text.matchAll(/(update|saveSettings|patch)\(\{/g)]
  for (const call of calls) {
    const start = call.index + call[0].length
    const end = text.indexOf('})', start)
    const block = text.slice(start, end === -1 ? start + 400 : end)
    if (new RegExp(`\\b${escape(key)}\\s*:`).test(block)) count += 1
    else if (new RegExp(`[{,]\\s*${escape(key)}\\s*[,}]`).test(block)) count += 1
  }
  return count
}

/** 反证尝试：字符串字面量、`as any` 邻域、IPC 文件里的同名串。 */
function countCounterEvidence(key, text, path) {
  const literal = [...text.matchAll(new RegExp(`['"\`]${escape(key)}['"\`]`, 'g'))].length
  const anyNear = [...text.matchAll(/as\s+(any|unknown\s+as)/g)].filter((hit) => {
    const start = Math.max(0, hit.index - 200)
    return text.slice(start, hit.index + 200).includes(key)
  }).length
  const ipc = /ipc\.ts$/.test(path) ? literal : 0
  return { literal, anyNear, ipc }
}

const files = walkSource()
const texts = new Map(files.map((path) => [path, read(path)]))
const shapeSource = texts.get(SHAPE_FILE) ?? read(SHAPE_FILE)
const fields = parseFields(shapeSource)
const defaults = parseDefaults(shapeSource)

const rows = fields.map((field) => {
  const reads = { dots: 0, destruct: 0, picks: 0, total: 0 }
  const writes = []
  const counter = { literal: 0, anyNear: 0, ipc: 0 }
  for (const [path, text] of texts) {
    if (path === SHAPE_FILE) continue
    const read = countReads(field.name, path, text)
    reads.dots += read.dots
    reads.destruct += read.destruct
    reads.picks += read.picks
    reads.total += read.total
    // 探针的写盘不算「产品里的第二个写口」：那是测试在验怎么存怎么读，不是用户能点到的入口。
    const write = /^src\/main\/probes\//.test(path) ? 0 : countWrites(field.name, text)
    if (write > 0) writes.push({ path, count: write })
    const back = countCounterEvidence(field.name, text, path)
    counter.literal += back.literal
    counter.anyNear += back.anyNear
    counter.ipc += back.ipc
  }
  const dead = reads.total === 0 && counter.literal === 0 && counter.anyNear === 0
  const suspicious = reads.total === 0 && !dead
  const verdict = dead
    ? '无人读（死配置）'
    : suspicious
      ? '可疑（只有反证命中）'
      : writes.length > 1
        ? '多处写'
        : RESTART_KEYS[field.name]
          ? '改了要重启'
          : NEXT_TIME_KEYS[field.name]
            ? '下次生效'
            : 'ok'
  return {
    key: field.name,
    type: field.type,
    optional: field.optional,
    default: defaults.get(field.name) ?? '（缺默认值）',
    reads,
    writes,
    counter,
    verdict
  }
})

const fieldNames = fields.map((f) => f.name)
const missingDefaults = fieldNames.filter((name) => !defaults.has(name))
const extraDefaults = [...defaults.keys()].filter((name) => !fieldNames.includes(name))
const dead = rows.filter((row) => row.verdict === '无人读（死配置）').map((row) => row.key)
const newDead = dead.filter((key) => !DEAD_BASELINE.includes(key))

/** 重启提示核对：那句话还在不在文件里。 */
const restartChecks = Object.entries(RESTART_KEYS).map(([key, info]) => {
  const text = existsSync(join(ROOT, info.hintFile)) ? read(info.hintFile) : ''
  return { key, reason: info.reason, hintFile: info.hintFile, present: text.includes(info.hintText) }
})

/** `--settings`：只读核对一份真实 settings.json 的未知键 / 缺键。 */
function inspectSettingsFile(path) {
  const abs = resolve(ROOT, path)
  if (!existsSync(abs)) return { path: abs, ok: false, error: '文件不存在' }
  try {
    const raw = JSON.parse(readFileSync(abs, 'utf8'))
    const keys = Object.keys(raw)
    return {
      path: abs,
      ok: true,
      unknown: keys.filter((key) => !fieldNames.includes(key)),
      missing: fieldNames.filter((name) => !keys.includes(name) && defaults.has(name) === false),
      count: keys.length
    }
  } catch (error) {
    return { path: abs, ok: false, error: String(error && error.message ? error.message : error) }
  }
}

const counts = rows.reduce((acc, row) => {
  acc[row.verdict] = (acc[row.verdict] ?? 0) + 1
  return acc
}, {})

if (JSON_OUT) {
  console.log(
    JSON.stringify(
      {
        fields: fields.length,
        defaults: defaults.size,
        counts,
        rows: rows.map((row) => ({
          key: row.key,
          type: row.type,
          optional: row.optional,
          default: row.default,
          reads: row.reads,
          writes: row.writes,
          counter: row.counter,
          verdict: row.verdict
        })),
        dead,
        newDead,
        restart: restartChecks,
        missingDefaults,
        extraDefaults
      },
      null,
      2
    )
  )
} else if (REPORT) {
  console.log('| 键 | 类型 | 默认值 | 读点 | 写点 | 反证 | 结论 |')
  console.log('| --- | --- | --- | --- | --- | --- | --- |')
  for (const row of rows) {
    const write = row.writes.map((w) => `${w.path}:${w.count}`).join('<br>') || '—'
    console.log(
      `| \`${row.key}\` | \`${row.type}\` | \`${row.default}\` | ${row.reads.total} | ${write} | ` +
        `${row.counter.literal}/${row.counter.anyNear}/${row.counter.ipc} | ${row.verdict} |`
    )
  }
} else {
  console.log(`设置巡检：${fields.length} 个字段（${defaults.size} 个默认值）`)
  const order = ['ok', '多处写', '改了要重启', '下次生效', '可疑（只有反证命中）', '无人读（死配置）']
  for (const verdict of order) console.log(`  ${verdict}：${counts[verdict] ?? 0}`)
  const multi = rows.filter((row) => row.writes.length > 1)
  if (multi.length > 0) {
    console.log('多写口：')
    for (const row of multi) {
      const note = MULTI_WRITE_NOTES[row.key]
      const tail =
        note === undefined || note === ''
          ? '（未注记）'
          : note.startsWith('有意') || note.startsWith('未注记')
            ? `（${note}）`
            : `（有意：${note}）`
      console.log(`  ${row.key} → ${row.writes.map((w) => w.path).join(' / ')} ${tail}`)
    }
  }
  for (const check of restartChecks) {
    console.log(`改完要重启：${check.key} 的提示${check.present ? '在' : '不见了'}（${check.hintFile}）`)
  }
  if (SETTINGS_PATH !== null) {
    const info = inspectSettingsFile(SETTINGS_PATH)
    if (info.ok !== true) console.log(`读不了 ${info.path}：${info.error}`)
    else
      console.log(
        `真实 settings.json：${info.count} 个键，未知键 ${info.unknown.length} 个${info.unknown.length > 0 ? `（${info.unknown.join(', ')}）` : ''}`
      )
  }
  console.log('（完整表格：node scripts/check-settings.mjs --report；机器可读：--json）')
}

const problems = []
if (missingDefaults.length > 0) problems.push(`AppSettings 有 ${missingDefaults.length} 个字段没有默认值：${missingDefaults.join(', ')}`)
if (extraDefaults.length > 0) problems.push(`DEFAULT_SETTINGS 有 ${extraDefaults.length} 个键不在 AppSettings 里：${extraDefaults.join(', ')}`)
if (newDead.length > 0) problems.push(`新增死配置 ${newDead.length} 条：${newDead.join(', ')}`)
const strictProblems = []
const missingHints = restartChecks.filter((check) => check.present === false)
if (missingHints.length > 0) strictProblems.push(`重启提示不见了：${missingHints.map((check) => check.key).join(', ')}`)
const unNoted = rows.filter((row) => row.writes.length > 1 && (MULTI_WRITE_NOTES[row.key] ?? '') === '')
if (unNoted.length > 0) strictProblems.push(`多写口未注记：${unNoted.map((row) => row.key).join(', ')}`)

for (const problem of problems) console.log(`设置巡检失败：${problem}`)
if (STRICT) for (const problem of strictProblems) console.log(`设置巡检失败（--strict）：${problem}`)
if (problems.length > 0 || (STRICT && strictProblems.length > 0)) process.exit(1)
