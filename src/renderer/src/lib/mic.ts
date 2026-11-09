import { pickCaptureDevice, type CaptureDevice } from '@shared/mic'

/** 录音约束：单声道 + 回声消除 + 降噪，两条录音腿（对讲 / 训练）共用。 */
export const MIC_CONSTRAINTS: MediaTrackConstraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true }

/**
 * 拿一路「能录到人声」的麦克风。
 *
 * 系统默认输入被设成虚拟声卡（VB-Cable 的 CABLE Output）时，直接 getUserMedia 只会录到静音——
 * 对讲报「没有检测到语音（RMS 0.0000）」。设备 label 只有授权后才可见，所以先按默认开一次拿到权限，
 * 再枚举、判断默认那路是不是虚拟线；是就换成真实麦克风重开一次。换不到就沿用第一路，不阻断录音。
 */
export async function openMicStream(): Promise<MediaStream> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS })
  try {
    const current = stream.getAudioTracks()[0]?.getSettings().deviceId ?? ''
    const devices: CaptureDevice[] = (await navigator.mediaDevices.enumerateDevices())
      .filter((device) => device.kind === 'audioinput')
      .map((device) => ({ deviceId: device.deviceId, label: device.label }))
    const pick = pickCaptureDevice(devices)
    if (!pick || pick === current) return stream
    const next = await navigator.mediaDevices.getUserMedia({ audio: { ...MIC_CONSTRAINTS, deviceId: { exact: pick } } })
    stream.getTracks().forEach((track) => track.stop())
    const label = devices.find((device) => device.deviceId === pick)?.label ?? ''
    console.log('MIC_SWITCH', JSON.stringify({ from: current, to: pick, label }))
    return next
  } catch (err) {
    // 换设备失败不致命：系统默认那路可能是用户故意选的，宁可录静音也别让对讲直接不可用。
    console.log('MIC_SWITCH_FAIL', JSON.stringify({ error: String(err) }))
    return stream
  }
}
