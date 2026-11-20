import { createServer } from 'node:net'
import { statfs } from 'node:fs/promises'
import os from 'node:os'
import { app } from 'electron'
import { gsiStatus, GSI_PORT } from './gsi'
import { judgeEnv, type EnvDeviceCounts, type EnvFacts, type EnvReport, type PortOwner } from '../../shared/env-report'

/**
 * 「这台机器」的取数：能自己量的主进程全量，量不到的留 null 让判据说「测不到」。
 *
 * 设备数是渲染层的活（`navigator.mediaDevices.enumerateDevices()`），由面板通过参数传进来；
 * 这里不申请任何权限——为了体检弹一次麦克风授权框，用户会以为我们在偷偷开麦。
 */

/** 端口探测：先问自己的监听状态，再试占一次。占得上说明空着，EADDRINUSE 说明有人在听。 */
async function probePortOwner(port: number): Promise<PortOwner> {
  if (gsiStatus().listening) return 'ours'
  return await new Promise<PortOwner>((resolve) => {
    const probe = createServer()
    const done = (owner: PortOwner): void => {
      probe.removeAllListeners()
      resolve(owner)
    }
    probe.once('error', (err: NodeJS.ErrnoException) => done(err.code === 'EADDRINUSE' ? 'other' : null))
    probe.once('listening', () => probe.close(() => done('free')))
    // 绑本地回环：绑 0.0.0.0 在 Windows 上会和防火墙提示扯上关系，这里只想问「有没有人占」。
    probe.listen({ port, host: '127.0.0.1', exclusive: true })
  })
}

async function diskFacts(dir: string): Promise<Pick<EnvFacts, 'diskFreeBytes' | 'diskTotalBytes' | 'diskPath'>> {
  try {
    const info = await statfs(dir)
    // bavail 是「非特权用户可用块数」，比 bfree 更接近人真正能写进去的空间。
    return { diskFreeBytes: info.bsize * Number(info.bavail), diskTotalBytes: info.bsize * Number(info.blocks), diskPath: dir }
  } catch {
    return { diskFreeBytes: null, diskTotalBytes: null, diskPath: dir }
  }
}

export async function envReport(devices: EnvDeviceCounts): Promise<EnvReport> {
  const cpus = os.cpus()
  const dataDir = app.getPath('userData')
  const facts: EnvFacts = {
    cpuModel: cpus[0]?.model ?? null,
    cpuCores: cpus.length > 0 ? cpus.length : null,
    freeMemBytes: os.freemem(),
    totalMemBytes: os.totalmem(),
    ...(await diskFacts(dataDir)),
    gsiPort: GSI_PORT,
    portOwner: await probePortOwner(GSI_PORT),
    micCount: devices.micCount,
    speakerCount: devices.speakerCount
  }
  return judgeEnv(facts)
}
