#!/usr/bin/env node
/**
 * shared 层循环依赖检查。
 *
 * 为什么要有这个脚本：`src/shared/` 的模块同时被主进程和渲染进程加载，
 * 一旦两个文件互相 `import`（尤其是取值而不是取类型），TypeScript 不报错、
 * bundler 也不报警，只在运行时表现成模块初始化顺序错乱（白屏、undefined 枚举），
 * 排查成本极高（2026-11-09 就为这个误判了好几轮）。
 *
 * 规则：`src/shared/` 内部只允许单向引用；跨层取值应放在被依赖更少的那个文件里，
 * 另一端用 `import type` 或本地字面量。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SHARED = join(ROOT, 'src', 'shared')
// 只认「取值」的 import：`import type` / `export type` 编译期就被擦掉，不构成运行时环。
const IMPORT_RE = /(?:^|[\s;])(?:import|export)\s+([\s\S]*?)from\s*['"]([^'"]+)['"]/g

function listSources(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) out.push(...listSources(full))
    else if (/\.tsx?$/.test(entry) && !entry.endsWith('.d.ts')) out.push(full)
  }
  return out
}

function resolveImport(fromFile, spec) {
  const target = spec.startsWith('@shared/')
    ? join(SHARED, spec.slice('@shared/'.length))
    : spec.startsWith('.')
      ? resolve(dirname(fromFile), spec)
      : null
  if (!target) return null
  for (const candidate of [target, `${target}.ts`, `${target}.tsx`, join(target, 'index.ts')]) {
    try {
      if (statSync(candidate).isFile()) return candidate
    } catch {
      // 不存在就试下一个候选
    }
  }
  return null
}

const files = listSources(SHARED)
const graph = new Map()
for (const file of files) {
  const text = readFileSync(file, 'utf8')
  const deps = []
  for (const match of text.matchAll(IMPORT_RE)) {
    if (/^\s*type\b/.test(match[1])) continue
    const target = resolveImport(file, match[2])
    if (target && target.startsWith(SHARED)) deps.push(target)
  }
  graph.set(file, deps)
}

const cycles = []
const state = new Map()
const stack = []

function walk(node) {
  state.set(node, 'visiting')
  stack.push(node)
  for (const dep of graph.get(node) ?? []) {
    const seen = state.get(dep)
    if (seen === 'visiting') {
      const at = stack.indexOf(dep)
      cycles.push([...stack.slice(at), dep])
    } else if (!seen) {
      walk(dep)
    }
  }
  stack.pop()
  state.set(node, 'done')
}

for (const file of files) if (!state.get(file)) walk(file)

if (cycles.length === 0) {
  console.log(`SHARED_CYCLES_OK ${files.length} 个文件，无循环依赖`)
  process.exit(0)
}

console.error(`SHARED_CYCLES_FAIL 发现 ${cycles.length} 条循环依赖：`)
for (const cycle of cycles) {
  console.error(`  ${cycle.map((file) => relative(ROOT, file)).join(' → ')}`)
}
console.error('修法：把共享的值（枚举数组、常量对象）放进被依赖更少的那个文件，另一端只 import type。')
process.exit(1)
