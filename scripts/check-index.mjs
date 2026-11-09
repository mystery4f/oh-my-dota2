#!/usr/bin/env node
/**
 * 文档索引漂移检查：`docs/` 下的每一份 markdown 都必须在 `docs/INDEX.md` 里出现，
 * 而 INDEX 里指向的每一份 markdown 都必须真的存在。
 *
 * 为什么要有这个脚本：AGENTS 要求「新增、改名、退役文档时同一批更新 INDEX」，但那是靠人记的。
 * 漏登记的那份文档从此没有任何入口——搜不到、也不会有人读，等于不存在。这个脚本把「漏登记」
 * 和「写了但没文件」都变成一条命令的失败。
 *
 * 只查存在性，不评判索引文字写得好不好——那件事人来做。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DOCS = join(ROOT, 'docs')
const INDEX = join(DOCS, 'INDEX.md')

function walk(dir) {
  const out = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else if (entry.name.endsWith('.md')) out.push(relative(ROOT, full).split('\\').join('/'))
  }
  return out
}

const index = readFileSync(INDEX, 'utf8')
const files = walk(DOCS).filter((file) => file !== 'docs/INDEX.md')
const referenced = [...new Set([...index.matchAll(/docs\/[\w./-]+\.md/g)].map((m) => m[0]))]

const unlisted = files.filter((file) => !index.includes(file))
const missing = referenced.filter((file) => !existsSync(join(ROOT, file)))

if (unlisted.length > 0) {
  console.log('这些文档没有登记进 docs/INDEX.md：')
  for (const file of unlisted) console.log(`  - ${file}`)
}
if (missing.length > 0) {
  console.log('docs/INDEX.md 指向了不存在的文档：')
  for (const file of missing) console.log(`  - ${file}`)
}
if (unlisted.length + missing.length === 0) {
  console.log(`文档索引一致（${files.length} 份文档，${referenced.length} 条引用）`)
  process.exit(0)
}
process.exit(1)
