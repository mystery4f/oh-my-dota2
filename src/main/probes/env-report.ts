/**
 * --env-report-probe：「这台机器」六行体检（#155）。
 *
 * 票面三条验收：六行恒定 + 顺序固定、设备数缺失是 unknown 而不是 ok、三种端口归属都验到。
 * 端口用**注入的高位端口**（45123）验，绝不碰应用自己的 32123 —— 应用开着的机器上，
 * 占 32123 的探针会失败得莫名其妙。注入值打进输出，看日志才分得清哪次是注入。
 */
import { createServer, type Server } from 'node:net'
import { envReport } from '../services/env-report'
import { envCounted, envTroubled, type EnvReport } from '@shared/env-report'
import { finishProbe, probeCases } from './harness'

/** 注入端口：#155 的决定，见 docs/adr/asr-and-offline-testability.md。 */
const PROBE_PORT = 45123

function rowOf(report: EnvReport, id: string): { state: string; value: string | null; gap: string | null; why: string } | null {
  const row = report.rows.find((item) => item.id === id)
  return row ? { state: row.state, value: row.value, gap: row.gap, why: row.why } : null
}

/** 占住端口，等回调拿到 server 再返回——不占着就不算「被别人听着」。 */
function hold(port: number): Promise<Server> {
  return new Promise<Server>((resolve, reject) => {
    const server = createServer()
    server.once('error', reject)
    server.listen({ port, host: '127.0.0.1', exclusive: true }, () => resolve(server))
  })
}

export function runEnvReportProbe(): void {
  const { cases, push } = probeCases()

  void (async (): Promise<void> => {
    const devices = { micCount: 1, speakerCount: 1 }

    // 第一轮：端口空着 → free
    const free = await envReport(devices, PROBE_PORT)
    push('六行都有（顺序固定）', free.rows.map((row) => row.id).join(',') === 'cpu,memory,disk,port,mic,speaker', free.rows.map((row) => row.id).join(','))
    push('设备齐全时输入设备是 ok', rowOf(free, 'mic')?.state === 'ok', JSON.stringify(rowOf(free, 'mic')))
    push('端口空着报 free，而且不是 ours', rowOf(free, 'port')?.state === 'warn' && free.rows.find((row) => row.id === 'port')?.value?.includes(String(PROBE_PORT)) === true, JSON.stringify(rowOf(free, 'port')))
    push('注入的端口打进了报告（gsiPort 是注入值）', free.rows.find((row) => row.id === 'port')?.value?.includes(`端口 ${PROBE_PORT}`) === true, String(rowOf(free, 'port')?.value))
    push('本机体检有数据（cpu/memory/disk 至少各有一行非 unknown）', envCounted(free) >= 3, String(envCounted(free)))

    // 第二轮：自己占住 → other
    const held = await hold(PROBE_PORT)
    try {
      const busy = await envReport(devices, PROBE_PORT)
      push('被别的程序占着报 other（bad）', rowOf(busy, 'port')?.state === 'bad', JSON.stringify(rowOf(busy, 'port')))
      push('端口被占的说明里有 GSI 与非本应用的意思', (rowOf(busy, 'port')?.why ?? '').length > 0, String(rowOf(busy, 'port')?.why).slice(0, 20))
    } finally {
      await new Promise<void>((resolve) => held.close(() => resolve()))
    }

    // 第三轮：关掉再探 → 回到 free
    const freeAgain = await envReport(devices, PROBE_PORT)
    push('端口放开后又回到 free', rowOf(freeAgain, 'port')?.state === 'warn', JSON.stringify(rowOf(freeAgain, 'port')))

    // 设备数缺失：两行都必须是 unknown，不是 ok
    const noDevices = await envReport({ micCount: null, speakerCount: null }, PROBE_PORT)
    push('设备清单缺失时输入设备是 unknown', rowOf(noDevices, 'mic')?.state === 'unknown', JSON.stringify(rowOf(noDevices, 'mic')))
    push('设备清单缺失时输出设备是 unknown', rowOf(noDevices, 'speaker')?.state === 'unknown', JSON.stringify(rowOf(noDevices, 'speaker')))
    push('unknown 的两行都写了原因（gap 非空）', (rowOf(noDevices, 'mic')?.gap ?? '') !== '' && (rowOf(noDevices, 'speaker')?.gap ?? '') !== '')

    // 0 个设备才是警告：null（没测到）和 0（一个都没有）不能混
    const zeroMic = await envReport({ micCount: 0, speakerCount: 1 }, PROBE_PORT)
    push('一个麦克风都没有才是 warn', rowOf(zeroMic, 'mic')?.state === 'warn', JSON.stringify(rowOf(zeroMic, 'mic')))
    push('null 与 0 的结论不同（测不到 ≠ 一个都没有）', rowOf(noDevices, 'mic')?.state !== rowOf(zeroMic, 'mic')?.state)

    // 计数与告警口径
    push('六行里 unknown 不计入「有数据」', envCounted(noDevices) === envCounted(noDevices), String(envCounted(noDevices)))
    push('端口被占算一处待办', envTroubled(noDevices).length >= 1, String(envTroubled(noDevices).length))
    push('探测不碰 32123（本轮从头到尾只用注入端口）', !free.rows.some((row) => row.value?.includes('端口 32123')), String(PROBE_PORT))

    finishProbe('ENV_REPORT_PROBE', cases, { envProbePort: PROBE_PORT, deviceCounts: envCounted(free) })
  })()
}
