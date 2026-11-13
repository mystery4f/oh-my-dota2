#!/usr/bin/env node
/**
 * `docs/PROBES.md` 里那段清单由 `src/main/probes/registry.ts` 生成。
 *
 * 不加参数 = 检查（不一致就退 1，列出差异）；`--write` = 重写那一段。
 * 从源码读而不是跑 electron：`check:probes` 挂在 lint 上，lint 不该要求先 build。
 */
import { readFileSync, writeFileSync } from 'node:fs'

const REGISTRY = 'src/main/probes/registry.ts'
const DOC = 'docs/PROBES.md'
const START = '<!-- probes:start -->'
const END = '<!-- probes:end -->'

function readRegistry() {
  const source = readFileSync(REGISTRY, 'utf8')
  const rows = []
  // 摘要可能跨行、也可以用 `+` 拼起来，所以先吃到 `run:` 再拼字符串字面量。
  const pattern = /flag: '(--[a-z-]+)',\s*summary:\s*([\s\S]*?)\n\s*run:/g
  let match
  while ((match = pattern.exec(source)) !== null) {
    const literals = match[2].match(/'([^']*)'/g) ?? []
    const summary = literals.map((item) => item.slice(1, -1)).join('')
    rows.push({ flag: match[1], summary })
  }
  return rows
}

function block(rows) {
  const lines = rows.map((row) => `  - \`${row.flag}\` ${row.summary}`)
  return [START, '  <!-- 这一段由 `npm run probes:doc` 生成，别手改；改表见 src/main/probes/registry.ts -->', ...lines, END]
}

const rows = readRegistry()
if (rows.length === 0) {
  console.error(`check:probes 在 ${REGISTRY} 里没解析到任何登记行`)
  process.exit(1)
}

const doc = readFileSync(DOC, 'utf8')
const lines = doc.split(/\r?\n/)
const startAt = lines.indexOf(START)
const endAt = lines.indexOf(END)
const generated = block(rows)

if (process.argv.includes('--write')) {
  const next = startAt >= 0 && endAt > startAt
    ? [...lines.slice(0, startAt), ...generated, ...lines.slice(endAt + 1)]
    : [...lines, '', ...generated, '']
  writeFileSync(DOC, next.join('\n'))
  console.log(`probes:doc 已写入 ${rows.length} 行`)
  process.exit(0)
}

const current = startAt >= 0 && endAt > startAt ? lines.slice(startAt, endAt + 1) : []
const missing = []
for (let index = 0; index < Math.max(current.length, generated.length); index++) {
  if (current[index] !== generated[index]) missing.push(`行 ${index + 1}: 文档「${current[index] ?? '(无)'}」 ≠ 表「${generated[index] ?? '(无)'}」`)
}
if (missing.length > 0) {
  console.error('check:probes 清单与 registry 不一致（改表后跑 npm run probes:doc）：')
  for (const line of missing.slice(0, 12)) console.error(`  ${line}`)
  process.exit(1)
}
console.log(`check:probes ${rows.length} 行一致`)
