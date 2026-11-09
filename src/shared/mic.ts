import { isVirtualCableName } from './voice-out'

/**
 * 拿来当麦克风只会录到静音或整机声音的输入端点。
 * 虚拟声卡（VB-Cable）自己的输出端就是典型：声出往 CABLE Input 里灌，CABLE Output 才有声音，
 * 用户对着真麦克风说话时它是静音的——系统默认输入一旦指到它，对讲必然「没有检测到语音（RMS 0）」。
 */
const UNUSABLE_INPUT = /立体声混音|stereo mix|wave out|what u hear|line in/i

export interface CaptureDevice {
  deviceId: string
  label: string
}

/**
 * 选一路能录到人声的输入端点：显式指定优先，其次第一块真实麦克风。
 * 返回 null = 没有可靠选择，调用方保留系统默认（比如还没授权、label 全是空的）。
 */
export function pickCaptureDevice(devices: CaptureDevice[], requested?: string): string | null {
  const usable = devices.filter(
    (device) =>
      device.deviceId &&
      device.deviceId !== 'default' &&
      device.deviceId !== 'communications' &&
      !isVirtualCableName(device.label) &&
      !UNUSABLE_INPUT.test(device.label)
  )
  if (requested && usable.some((device) => device.deviceId === requested)) return requested
  return usable[0]?.deviceId ?? null
}
