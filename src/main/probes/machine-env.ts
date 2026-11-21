/**
 * --machine-env-probe：机器级三行（#179）。
 *
 * 票面验收：显存四档各自一句且「测不到」不亮绿、三种缺失三句不同都说得出下一步、汇总句
 * 在「全绿」与「有一项坏」下不同、纯缝不读盘不跑命令。
 *
 * 做法：**只喂事实**给 `judgeMachineEnv()`，不起 Python、不跑 nvidia-smi —— 探针在 CI 上跑，
 * 那里既没有 GV 也没有 N 卡；真采集由 `machineEnv()` 负责，它的分支用 docs 里的口径核对。
 */
import {
  judgeMachineEnv,
  machineEnvLine,
  machineEnvState,
  type MachineEnvFacts
} from '@shared/machine-env'
import { finishProbe, probeCases } from './harness'

function facts(over: Partial<MachineEnvFacts> = {}): MachineEnvFacts {
  return {
    asrPython: { path: 'C:/asr-ft-env/venv/Scripts/python.exe', version: '3.11.9', error: null },
    gvPython: { path: 'C:/voice-runtime/runtime/python.exe', version: '3.10.13', error: null },
    asrMissing: [],
    gvMissing: [],
    asrDepsError: null,
    gvDepsError: null,
    vram: {
      totalMiB: 6144,
      usedMiB: 1900,
      freeMiB: 4244,
      ok: true,
      needMiB: 6400,
      holders: [],
      note: null
    },
    vramError: null,
    ...over
  }
}

function rowLine(f: MachineEnvFacts, id: 'python' | 'deps' | 'vram'): string {
  return judgeMachineEnv(f).rows.find((row) => row.id === id)?.line ?? ''
}

function rowState(f: MachineEnvFacts, id: 'python' | 'deps' | 'vram'): string {
  return judgeMachineEnv(f).rows.find((row) => row.id === id)?.state ?? ''
}

export function runMachineEnvProbe(): void {
  const { cases, push } = probeCases()

  const healthy = facts()
  const healthyReport = judgeMachineEnv(healthy)
  push(
    '三行顺序固定 python → deps → vram',
    healthyReport.rows.map((row) => row.id).join(',') === 'python,deps,vram'
  )
  push(
    '全绿时汇总句是「能跑训练与合成」',
    healthyReport.line === '这台机器能跑训练与合成',
    healthyReport.line
  )
  push('全绿时 ready 为真', healthyReport.ready && machineEnvState(healthyReport) === 'ok')

  // 三种缺失：三句必须不同，且各自说得出下一步
  const asrNoPython = facts({
    asrPython: { path: null, version: null, error: null },
    asrMissing: null,
    asrDepsError: '解释器不在'
  })
  const gvNoPython = facts({
    gvPython: { path: null, version: null, error: null },
    gvMissing: null,
    gvDepsError: '解释器不在'
  })
  const gvNoDep = facts({ gvMissing: ['soundfile'] })
  const l1 = rowLine(asrNoPython, 'python')
  const l2 = rowLine(gvNoPython, 'python')
  const l3 = rowLine(gvNoDep, 'deps')
  push('识别训练缺 Python 说得出「识别训练」', l1.includes('识别训练') && l1.includes('重装'), l1)
  push('音色合成缺 Python 说得出「音色合成」', l2.includes('音色合成') && l2.includes('重装'), l2)
  push('缺依赖时点名包与安装动作', l3.includes('soundfile') && l3.includes('pip install'), l3)
  push('三种缺失三句互不相同', new Set([l1, l2, l3]).size === 3, `${l1} | ${l2} | ${l3}`)
  push('缺依赖的行状态是 bad', rowState(gvNoDep, 'deps') === 'bad', rowState(gvNoDep, 'deps'))
  push(
    '缺依赖时依赖段带「为什么需要它」',
    (judgeMachineEnv(gvNoDep).rows[1]?.segments[1]?.text ?? '').includes('wav'),
    JSON.stringify(judgeMachineEnv(gvNoDep).rows[1]?.segments[1])
  )

  // 依赖测不到 ≠ 依赖齐
  const depsUnknown = facts({ asrMissing: null, asrDepsError: '解释器被别的进程占着' })
  push(
    '依赖测不到时是 unknown 而不是 ok',
    rowState(depsUnknown, 'deps') === 'unknown',
    rowState(depsUnknown, 'deps')
  )
  push(
    '依赖测不到时写得出原因',
    rowLine(depsUnknown, 'deps').includes('解释器被别的进程占着'),
    rowLine(depsUnknown, 'deps')
  )

  // 显存四档
  const tight = facts({
    vram: {
      totalMiB: 6144,
      usedMiB: 5200,
      freeMiB: 944,
      ok: false,
      needMiB: 6400,
      holders: ['dota2.exe 2100 MiB'],
      note: '显存偏紧：整卡已用 5200 / 6144 MiB'
    }
  })
  const noGpu = facts({ vram: null, vramError: '没有 nvidia-smi（核显或驱动没装）' })
  push(
    '显存够用写「够用」并给数字',
    rowLine(healthy, 'vram').includes('够用') && rowLine(healthy, 'vram').includes('4244'),
    rowLine(healthy, 'vram')
  )
  push(
    '显存偏紧用 ftVramNote 的原话',
    rowLine(tight, 'vram').startsWith('显存偏紧：整卡已用 5200'),
    rowLine(tight, 'vram')
  )
  push('显存偏紧点名占卡程序', rowLine(tight, 'vram').includes('dota2.exe'), rowLine(tight, 'vram'))
  push('显存偏紧是 warn（不拦训练）', rowState(tight, 'vram') === 'warn', rowState(tight, 'vram'))
  push(
    '显存测不到写原因且不是 ok',
    rowState(noGpu, 'vram') === 'unknown' && rowLine(noGpu, 'vram').startsWith('测不到：'),
    rowLine(noGpu, 'vram')
  )
  push('显存测不到不算 ready', !judgeMachineEnv(noGpu).ready)

  // 汇总句三种输入三个样
  const lines = [healthyReport.line, judgeMachineEnv(gvNoDep).line, judgeMachineEnv(noGpu).line]
  push('汇总句「全绿 / 坏 / 测不到」三种都不同', new Set(lines).size === 3, lines.join(' | '))
  push(
    '汇总句在坏的时候点名那一行',
    judgeMachineEnv(gvNoDep).line.includes('依赖'),
    judgeMachineEnv(gvNoDep).line
  )
  push(
    'machineEnvLine 把汇总与三行串成一句',
    machineEnvLine(healthyReport).split(' · ').length === 4,
    machineEnvLine(healthyReport)
  )

  finishProbe('MACHINE_ENV_PROBE', cases, { rows: healthyReport.rows.map((row) => row.id) })
}
