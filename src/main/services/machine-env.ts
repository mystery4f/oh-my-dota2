/**
 * 机器级事实的采集（#179）：只读，不装不改。
 *
 * 三件事各自去找现成的来源，判据一律在原处，这里只做「取数 → 喂给纯缝」：
 *   - Python：识别训练用 `detectAsrFtEnv()` 已解析出的解释器；音色合成用 GV 安装目录里的 `runtime/python.exe`。
 *   - 依赖：识别训练读引擎表的 `pythonExtra`；音色合成读纯缝里的 `GV_PY_DEPS`。
 *   - 显存：`nvidia-smi` 在这里问一次，判定仍走 `judgeFtVram()` / `ftVramNote()`。
 *
 * 为什么显存的 `nvidia-smi` 在这里又写了一遍：`src/main/services/train/asr-ft.ts:766` 的 `ftVramGuard()`
 * 是「开训那一刻」的口径（还带自家 GV 让路），它没导出、也不该被两处共用同一份时序假设；
 * 重复的只是那两行查询，判定与文案都在 `src/shared/train/asr-ft.ts`，所以不会走样。
 *
 * 进程内缓存 5 秒：两页各轮询一次不该让 `nvidia-smi` 与本机 Python 反复起进程。
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import {
  FT_TRAIN_NEED_MIB,
  ftVramNote,
  judgeFtVram,
  parseNvidiaComputeApps,
  type FtGpuApp
} from '@shared/train/asr-ft'
import {
  GV_PY_DEPS,
  judgeMachineEnv,
  type MachineEnvFacts,
  type MachineEnvReport,
  type PythonFacts
} from '@shared/machine-env'
import { detectAsrFtEnv } from './train/asr-ft'
import { finetuneSpec } from './train/target-engine'
import { sovitsInstallHome } from './voice/sovits-install'
import { sovitsChildPid } from './voice/sovits-server'

const CACHE_MS = 5000
const PROBE_TIMEOUT_MS = 20_000

let cached: { at: number; report: MachineEnvReport } | null = null

/** 解释器版本：`python -c "import sys; print(sys.version.split()[0])"`。问不出来要说原因，不能当「没装」。 */
function probePython(exe: string | null): PythonFacts {
  if (exe === null || !existsSync(exe)) return { path: null, version: null, error: null }
  const done = spawnSync(exe, ['-c', 'import sys; print(sys.version.split()[0])'], {
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
    encoding: 'utf8'
  })
  if (done.error !== undefined && done.error !== null) {
    return { path: exe, version: null, error: `起来就报错：${done.error.message}` }
  }
  const version =
    String(done.stdout ?? '')
      .trim()
      .split(/\r?\n/)
      .pop() ?? ''
  if (done.status !== 0 || version === '') {
    return { path: exe, version: null, error: `退出码 ${String(done.status)}，没打印版本` }
  }
  return { path: exe, version, error: null }
}

/**
 * 缺哪些包：`importlib.util.find_spec` 一次问完。
 * 返回 `null` 表示**测不到**（解释器不在 / 命令跑不起来）——这与「都齐了」不是一回事。
 */
function probeMissing(
  exe: string | null,
  packages: readonly string[]
): { missing: string[] | null; error: string | null } {
  if (exe === null || !existsSync(exe)) return { missing: null, error: '解释器不在' }
  if (packages.length === 0) return { missing: [], error: null }
  const probe = `import importlib.util as u, json; print(json.dumps([m for m in ${JSON.stringify(packages)} if u.find_spec(m) is None]))`
  const done = spawnSync(exe, ['-c', probe], {
    timeout: PROBE_TIMEOUT_MS,
    windowsHide: true,
    encoding: 'utf8'
  })
  if (done.error !== undefined && done.error !== null)
    return { missing: null, error: done.error.message }
  if (done.status !== 0) {
    const tail =
      String(done.stderr ?? '')
        .trim()
        .split(/\r?\n/)
        .pop() ?? ''
    return { missing: null, error: tail === '' ? `退出码 ${String(done.status)}` : tail }
  }
  try {
    const parsed: unknown = JSON.parse(String(done.stdout).trim().split(/\r?\n/).pop() ?? '[]')
    return { missing: Array.isArray(parsed) ? parsed.map((one) => String(one)) : null, error: null }
  } catch {
    return { missing: null, error: '输出的不是 JSON' }
  }
}

/** 显存：查不到就回 `null` + 原因（核显 / 驱动没装 / 输出看不懂），绝不假装「够用」。 */
function probeVram(): { vram: MachineEnvFacts['vram']; error: string | null } {
  const q = spawnSync(
    'nvidia-smi',
    ['--query-gpu=memory.total,memory.used', '--format=csv,noheader,nounits'],
    {
      timeout: 5000,
      windowsHide: true,
      encoding: 'utf8'
    }
  )
  if (q.error !== undefined && q.error !== null)
    return { vram: null, error: '没有 nvidia-smi（核显或驱动没装）' }
  if (q.status !== 0)
    return { vram: null, error: 'nvidia-smi 跑不起来（驱动在，但这一版被禁用了？）' }
  const [totalMiB, usedMiB] = String(q.stdout ?? '')
    .trim()
    .split(',')
    .map((one) => Number(one.trim()))
  if (!Number.isFinite(totalMiB) || !Number.isFinite(usedMiB)) {
    return { vram: null, error: 'nvidia-smi 的输出看不懂' }
  }
  const raw = spawnSync(
    'nvidia-smi',
    ['--query-compute-apps=pid,process_name,used_memory', '--format=csv,noheader,nounits'],
    {
      timeout: 5000,
      windowsHide: true,
      encoding: 'utf8'
    }
  )
  const apps: FtGpuApp[] =
    raw.error !== undefined || raw.status !== 0 ? [] : parseNvidiaComputeApps(String(raw.stdout))
  const ownPid = sovitsChildPid()
  const excludePids = ownPid === null ? [] : [ownPid]
  const verdict = judgeFtVram({ totalMiB, usedMiB, apps, excludePids })
  return {
    vram: {
      totalMiB,
      usedMiB,
      freeMiB: verdict.freeMiB,
      ok: verdict.ok,
      needMiB: FT_TRAIN_NEED_MIB,
      holders: verdict.holders,
      note: ftVramNote({ totalMiB, usedMiB, apps, excludePids })
    },
    error: null
  }
}

/** 采集三件事并折叠成三行。只读：不装包、不改设置、不连 provider。 */
export async function machineEnv(): Promise<MachineEnvReport> {
  const now = Date.now()
  if (cached !== null && now - cached.at < CACHE_MS) return cached.report

  const env = detectAsrFtEnv()
  const asrPython = probePython(env.paths.pythonExe ?? null)
  const gvPython = probePython(join(sovitsInstallHome(), 'runtime', 'python.exe'))

  const asr = probeMissing(asrPython.path, finetuneSpec().pythonExtra)
  const gv = probeMissing(
    gvPython.path,
    GV_PY_DEPS.map((dep) => dep.name)
  )
  const gpu = probeVram()

  const facts: MachineEnvFacts = {
    asrPython,
    gvPython,
    asrMissing: asr.missing,
    gvMissing: gv.missing,
    asrDepsError: asr.error,
    gvDepsError: gv.error,
    vram: gpu.vram,
    vramError: gpu.error
  }
  const report = judgeMachineEnv(facts)
  cached = { at: now, report }
  return report
}

/** 探针与测试用：清掉缓存，下一次 `machineEnv()` 重新采集。 */
export function resetMachineEnv(): void {
  cached = null
}
