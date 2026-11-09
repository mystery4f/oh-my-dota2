import { execFile } from 'node:child_process'
import { isVirtualCableName, matchVirtualCable, type VirtualCableStatus } from '@shared/voice-out'

/**
 * VB-Cable 检测：问驱动层，不问浏览器。
 *
 * 端点名读 MMDevices 注册表，驱动名读 `Win32_SoundDevice`，服务状态读 SCM：三样都不碰麦克风、不要授权。
 * 渲染层 `enumerateDevices()` 在授权前拿不到 `label`：空名字不能当「没装」的证据。
 *
 * 只读一次设备清单与一个服务状态；结果缓存几秒，避免面板来回切换时反复起 PowerShell。
 */

const TIMEOUT_MS = 15000
/** 检测缓存：装驱动/重启端点后重新进页面即可，不必每一帧都重查。 */
const TTL_MS = 5000

/**
 * 纯 ASCII：PowerShell 5.1 按 ANSI 代码页解析 `-Command`，中文注释/输出会把字符吃坏。
 * 设备名可能带中文（「扬声器 (Realtek)」），匹配只认 ASCII 的 vb-audio / cable。
 */
/** 端点友好名在注册表 Properties 下的值名（Windows 固定的 PKEY_Device_FriendlyName）。 */
const FRIENDLY_NAME = '{a45c254e-df1c-4efd-8020-67d146a850e0},2'

/**
 * 纯 ASCII：PowerShell 5.1 按 ANSI 代码页解析 `-Command`，中文注释/输出会把字符吃坏。
 * 端点只读注册表（Render + Capture）：`Get-PnpDevice` 要 2–3 秒且常撞 CIM 忙，
 * 8 秒超时会把它判成「没装」——那是看不见的假阴性。
 */
const SCRIPT = [
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
  `$g='${FRIENDLY_NAME}'`,
  `foreach($k in 'Render','Capture'){Get-ChildItem "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\$k" -ErrorAction SilentlyContinue|ForEach-Object{$p=Get-ItemProperty "$($_.PSPath)\\Properties" -ErrorAction SilentlyContinue;if($p -and $p.PSObject.Properties.Name -contains $g){'NAME:'+$p.$g}}}`,
  'try{(Get-CimInstance Win32_SoundDevice -ErrorAction Stop).Name|ForEach-Object{"CIM:"+$_}}catch{}',
  'try{$svc=Get-Service -Name VBAudioVACWDM -ErrorAction Stop;"SERVICE:"+$svc.Status}catch{}',
  'exit 0'
].join('; ')

let cached: { at: number; status: VirtualCableStatus } | null = null

/** 检测系统里有没有 VB-Cable；缓存过期或失败后调用方可以隔几秒再来一次。 */
export async function detectVirtualCable(): Promise<VirtualCableStatus> {
  if (cached && Date.now() - cached.at < TTL_MS) return cached.status
  const status = await query()
  // 查询失败不缓存：下一次进来应该重新试，而不是把一次超时钉成「没装」。
  cached = status.error === null ? { at: Date.now(), status } : null
  return status
}

function query(): Promise<VirtualCableStatus> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT],
      { timeout: TIMEOUT_MS, windowsHide: true, encoding: 'utf8', maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          const reason = error.killed ? `PowerShell 超过 ${TIMEOUT_MS / 1000} 秒没返回` : error.message
          resolve({ installed: false, endpoints: [], driverOnly: false, error: reason })
          return
        }
        const lines = stdout.split(/\r?\n/).filter((line) => line.trim().length > 0)
        // 一条设备都没有 = 脚本没真跑成（exit 0 是显式给的，否则缺服务也会让进程返回 1）。
        if (lines.length === 0) {
          resolve({ installed: false, endpoints: [], driverOnly: false, error: 'PowerShell 没返回任何设备信息' })
          return
        }
        // NAME 只来自端点注册表；驱动名/服务单独算：驱动在而端点没出现 = driverOnly。
        const names = lines.filter((line) => line.startsWith('NAME:')).map((line) => line.slice('NAME:'.length))
        const service = lines.some((line) => line.startsWith('SERVICE:'))
        const driverSeen =
          service || lines.some((line) => line.startsWith('CIM:') && isVirtualCableName(line.slice('CIM:'.length)))
        const endpoints = matchVirtualCable(names)
        const installed = endpoints.length > 0 || driverSeen
        resolve({
          installed,
          endpoints,
          driverOnly: driverSeen && endpoints.length === 0,
          error: null
        })
      }
    )
  })
}
