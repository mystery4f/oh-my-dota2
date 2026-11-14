#!/usr/bin/env node
/**
 * 跑一个探针：先收掉残留的 electron，再交出真实的退出码。
 *
 * 为什么要一层包装：
 * - 残留进程握着单实例锁，探针会**静默**退出（约 3 秒、没有 PASS 行、退出码 0），
 *   看起来像「跑过了」。手工流程里每个人都要记得先 taskkill，忘一次就误判一次。
 * - `npm run probe` 以前是裸 `electron out/main/index.js`，失败时 npm 只给一段
 *   ELIFECYCLE 噪音，真实的退出码藏在里面。
 *
 * 用法：`npm run probe -- --chat-block-probe`（参数原样传给应用）。
 */
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'

const flags = process.argv.slice(2)
if (flags.length === 0) {
  console.error('用法：npm run probe -- --chat-block-probe')
  console.error('清单：npm run probes:doc 生成 docs/PROBES.md，或看 src/main/probes/registry.ts')
  process.exit(2)
}

const root = process.cwd()
const entry = path.join(root, 'out', 'main', 'index.js')
if (!existsSync(entry)) {
  console.error(`没有 ${path.relative(root, entry)}：先 npm run build`)
  process.exit(2)
}

// 拼错一个标志的代价是「应用正常启动、卡在界面上不退出」——所以先对表，不在表里就直接拒绝。
// 表里没有的附属开关（例如 `--asr-swap-apply`）不拦：只要求有一个参数是登记过的探针。
const registry = readFileSync(path.join(root, 'src', 'main', 'probes', 'registry.ts'), 'utf8')
const known = [...registry.matchAll(/flag: '(--[a-z0-9-]+)'/g)].map((match) => match[1])
if (!flags.some((flag) => known.includes(flag))) {
  console.error(`没有这个探针：${flags.join(' ')}`)
  console.error('清单：npm run probes:doc 生成 docs/PROBES.md，或看 src/main/probes/registry.ts')
  process.exit(2)
}

/** 收掉残留的 electron。Windows 上 taskkill 的 /F 会被 Git Bash 当成路径，所以走 powershell。 */
function killStrayElectron() {
  if (process.platform === 'win32') {
    spawnSync('powershell', ['-NoProfile', '-Command', 'Stop-Process -Name electron -Force -ErrorAction SilentlyContinue'], { stdio: 'ignore' })
    return
  }
  spawnSync('pkill', ['-f', 'electron'], { stdio: 'ignore' })
}

killStrayElectron()

const electron = spawn('npx', ['electron', entry, ...flags], {
  stdio: 'inherit',
  shell: process.platform === 'win32'
})

electron.on('close', (code, signal) => {
  if (signal) {
    console.error(`探针被信号终止：${signal}`)
    process.exit(1)
  }
  if (code !== 0) console.error(`探针失败：退出码 ${code}（上面应有一行 FAIL 或 PROBE_NO_CASES）`)
  process.exit(code ?? 1)
})
