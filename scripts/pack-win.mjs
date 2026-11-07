/**
 * `npm run pack:win` — one command for the Windows installer on a China network.
 *
 * Two failures this script removes: electron-builder downloads the Electron zip and the
 * builder binaries from GitHub, which either times out or dies with
 * `unable to verify the first certificate`; and after packing, installing still means
 * finding the exe, closing the running copy and running `/S` by hand.
 *
 * Steps: secret guard → `electron-vite build` → `electron-builder --win` → optional install.
 *
 * Flags:
 *   --skip-build   reuse the current `out/`
 *   --no-guard     skip the API-key guard
 *   --install      run the installer silently (closes a running oh-my-dota2.exe first)
 *   --dir <path>   install directory (--install verifies it, --swap writes into it)
 *   --swap         JS-only change: pack `--dir` and copy just resources/app.asar, keeps app.asar.bak
 *   --force        install/swap even while a training run is active (kills that run)
 *
 * Examples:
 *   npm run pack:win                 build + pack, prints the installer path
 *   npm run pack:install             same, then silently install what was just built
 *   npm run pack:win -- --skip-build keep the current build, only repack
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const argv = process.argv.slice(2)
const flag = (name) => argv.includes(name)
const value = (name) => {
  const at = argv.indexOf(name)
  return at >= 0 ? argv[at + 1] : null
}

const ROOT = process.cwd()
const DIST = join(ROOT, 'dist')

// 国内镜像：electron-builder 下载 Electron 与 nsis/winCodeSign 全走这里，直连 GitHub 必失败。
const env = {
  ...process.env,
  ELECTRON_MIRROR: process.env.ELECTRON_MIRROR ?? 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR:
    process.env.ELECTRON_BUILDER_BINARIES_MIRROR ?? 'https://registry.npmmirror.com/-/binary/electron-builder-binaries/'
}

function run(label, bin, args) {
  process.stdout.write(`\n== ${label}\n`)
  // 不借 shell：Windows 上 spawn 带 shell:true 会打出 DEP0190，且参数不再转义。
  // 二进制一律用 node 直跑包的入口 JS，路径写死相对 node_modules（本项目无 pnpm 扁平化差异）。
  const r = spawnSync(bin, args, { stdio: 'inherit', env, cwd: ROOT })
  if (r.status !== 0) {
    const why = r.error ? r.error.message : `exit=${String(r.status)}`
    console.error(`\n✗ ${label} 失败：${why}`)
    if (label.startsWith('pack')) {
      console.error('  证书/超时类报错先确认镜像可达：curl -I https://npmmirror.com/mirrors/electron/')
    }
    process.exit(r.status ?? 1)
  }
}

/** dist/ 里最新的安装包（排除 `__uninstaller` 中间产物与 blockmap）。 */
function latestInstaller() {
  if (!existsSync(DIST)) return null
  const found = readdirSync(DIST)
    .filter((name) => /^oh-my-dota2-[\d.]+-x64\.exe$/.test(name))
    .map((name) => join(DIST, name))
    .map((path) => ({ path, mtime: statSync(path).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)
  return found[0]?.path ?? null
}

/** 每个 python 进程的命令行（判断训练是否真的在跑）。 */
function trainCommandLines() {
  const ps = spawnSync(
    'powershell',
    [
      '-NoProfile',
      '-Command',
      "(Get-CimInstance Win32_Process -Filter \"Name='python.exe'\" | ForEach-Object { $_.CommandLine }) -join [Environment]::NewLine"
    ],
    { encoding: 'utf8' }
  )
  return (ps.stdout ?? '').split(/\r?\n/).filter(Boolean)
}

/** 真在跑的训练 run id：run.json 说 running，并且有 python 命令行提到它。
 *  训练被强杀时 run.json 会永远停在 running（本仓库已踩过两次），所以只信进程；
 *  进程看不到时给 10 分钟宽限，覆盖「刚起、命令行还没出现在 WMI 里」。 */
function activeTrainRuns(dir) {
  const runs = join(`${dir}-data`, 'asr-ft-runs')
  if (!existsSync(runs)) return []
  const lines = trainCommandLines()
  return readdirSync(runs).filter((name) => {
    const manifest = join(runs, name, 'run.json')
    if (!existsSync(manifest)) return false
    try {
      if (JSON.parse(readFileSync(manifest, 'utf8')).status !== 'running') return false
    } catch {
      return false
    }
    const fresh = Date.now() - statSync(manifest).mtimeMs < 10 * 60 * 1000
    return fresh || lines.some((line) => line.includes(name))
  })
}

/** 训练在跑就拒绝装包：这个脚本会 taskkill，本仓库曾被它毁掉两轮训练。 */
function assertNoActiveTrain(dir) {
  const running = activeTrainRuns(dir)
  if (running.length === 0 || flag('--force')) return
  console.error(`✗ 训练正在跑（${running.join('、')}）：关掉应用会毁掉这一轮。`)
  console.error('  等它跑完再装；确实要中断就加 --force。')
  process.exit(1)
}

function killRunning() {
  const list = spawnSync('tasklist', ['/FI', 'IMAGENAME eq oh-my-dota2.exe'], { encoding: 'utf8' })
  if (!list.stdout?.includes('oh-my-dota2.exe')) return
  console.log('关闭正在运行的安装版…')
  spawnSync('taskkill', ['/F', '/IM', 'oh-my-dota2.exe'], { stdio: 'ignore' })
}

function reportAsar(dir) {
  const asar = join(dir, 'resources', 'app.asar')
  if (!existsSync(asar)) {
    console.log(`校验跳过：${asar} 不存在（用 --dir 指对安装目录）`)
    return
  }
  const st = statSync(asar)
  console.log(`已安装：${asar}  ${(st.size / 1024 / 1024).toFixed(1)} MB  ${st.mtime.toLocaleString()}`)
}

/** 安装目录：--dir → OMD2_INSTALL_DIR → 注册表（NSIS 写的 InstallLocation）→ %LOCALAPPDATA% 默认。 */
function installDir() {
  const explicit = value('--dir') ?? process.env.OMD2_INSTALL_DIR
  if (explicit) return explicit
  for (const root of ['HKCU', 'HKLM']) {
    const key = `${root}\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\oh-my-dota2`
    const r = spawnSync('reg', ['query', key, '/v', 'InstallLocation'], { encoding: 'utf8' })
    const hit = /InstallLocation\s+REG_SZ\s+(.+)/.exec(r.stdout ?? '')
    if (hit) return hit[1].trim()
  }
  return join(process.env.LOCALAPPDATA ?? '', 'Programs', 'oh-my-dota2')
}

if (!flag('--skip-build')) {
  if (!flag('--no-guard')) run('guard（安装包里不许出现 API key）', process.execPath, ['scripts/guard-secrets.mjs'])
  run('build（electron-vite）', process.execPath, ['node_modules/electron-vite/bin/electron-vite.js', 'build'])
}

// --swap：只换 app.asar。纯 JS 改动（Electron 版本、resources/、原生依赖都没变）时，
// NSIS 解包重写整个安装目录要一两分钟，这里只拷一个文件；旧的那个留成 app.asar.bak 好回滚。
if (flag('--swap')) {
  run('pack（electron-builder --dir，只要 app.asar）', process.execPath, [
    'node_modules/electron-builder/out/cli/cli.js',
    '--win',
    '--x64',
    '--dir',
    '--publish',
    'never'
  ])
  const source = join(DIST, 'win-unpacked', 'resources', 'app.asar')
  if (!existsSync(source)) {
    console.error(`✗ 没找到 ${source}，换成 pack:install`)
    process.exit(1)
  }
  const target = join(installDir(), 'resources', 'app.asar')
  if (!existsSync(target)) {
    console.error(`✗ 安装目录里没有 ${target}，用 --dir <安装目录> 指一下，或直接 npm run pack:install`)
    process.exit(1)
  }
  assertNoActiveTrain(installDir())
  killRunning()
  copyFileSync(target, `${target}.bak`)
  copyFileSync(source, target)
  reportAsar(join(installDir()))
  console.log('换完：重开应用即生效；回滚就把 app.asar.bak 覆盖回去')
  process.exit(0)
}
run('pack（electron-builder --win x64）', process.execPath, [
  'node_modules/electron-builder/out/cli/cli.js',
  '--win',
  '--x64',
  '--publish',
  'never'
])

const installer = latestInstaller()
if (!installer) {
  console.error('✗ dist/ 里没有 oh-my-dota2-*-x64.exe，打包没真正产出')
  process.exit(1)
}
console.log(`\n安装包：${installer}  ${(statSync(installer).size / 1024 / 1024).toFixed(1)} MB`)

if (!flag('--install')) {
  console.log('安装：npm run pack:install（会先关掉正在运行的安装版）')
  process.exit(0)
}

assertNoActiveTrain(installDir())
killRunning()
run('install（NSIS 静默 /S）', installer, ['/S'])
reportAsar(installDir())
