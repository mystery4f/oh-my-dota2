/**
 * 打包前的守门人：安装包与构建产物里绝不能出现任何人的 API key。
 *
 * 真实踩点：开发机上有 `data/settings.json`（存着自己的 key），
 * 一旦它被打进 asar 或者被 `git add -A` 带进仓库，用户装到的就是「拿别人的 key 跑」的包。
 * 这个脚本只做两件事：源码/产物里搜 key 的字面量形态；确认 `data/` 不在待发布目录里。
 */

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'

const ROOT = process.cwd()
const KEY_PATTERNS = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bAIza[A-Za-z0-9_-]{30,}/,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/
]

/** 这些目录/文件不参与发布，也不该去扫（大、或本来就是用户数据）。 */
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'data', '.tmp', 'out', 'build'])
const SCAN_DIRS = ['src', 'scripts', 'out']

function walk(dir, hits) {
  if (!existsSync(dir)) return
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue
    const full = join(dir, name)
    const info = statSync(full)
    if (info.isDirectory()) {
      walk(full, hits)
      continue
    }
    if (!/\.(ts|tsx|js|mjs|cjs|json|html|yml|yaml)$/.test(name)) continue
    const text = readFileSync(full, 'utf8')
    for (const pattern of KEY_PATTERNS) {
      const match = text.match(pattern)
      if (match) hits.push({ file: full.replace(ROOT + '\\', '').replace(ROOT + '/', ''), sample: match[0].slice(0, 6) + '…' })
    }
  }
}

const hits = []
for (const dir of SCAN_DIRS) walk(join(ROOT, dir), hits)

/** 发布目录里出现 `data/` 就是配置泄漏的前兆：安装版会在用户机器上重建它。 */
const leakedData = ['dist/win-unpacked/data', 'dist/mac/data', 'dist/linux-unpacked/data'].filter((dir) =>
  existsSync(join(ROOT, dir))
)

/** 仓库里被跟踪的 data/ 文件（这台机器上 data/ 已 gitignore，兜底再查一次）。 */
let trackedData = ''
try {
  trackedData = execFileSync('git', ['ls-files', 'data'], { encoding: 'utf8' }).trim()
} catch {
  trackedData = ''
}

const problems = []
if (hits.length > 0) {
  problems.push(`构建产物或源码里出现疑似 key：${hits.map((hit) => `${hit.file}(${hit.sample})`).join(', ')}`)
}
if (leakedData.length > 0) problems.push(`发布目录里混进了用户数据：${leakedData.join(', ')}`)
if (trackedData) problems.push(`git 跟踪了 data/：${trackedData.split('\n').slice(0, 3).join(', ')}`)

if (problems.length > 0) {
  console.error('GUARD_SECRETS failed:')
  for (const problem of problems) console.error(' - ' + problem)
  process.exit(1)
}

console.log('GUARD_SECRETS ok', { scanned: SCAN_DIRS, hits: 0 })
