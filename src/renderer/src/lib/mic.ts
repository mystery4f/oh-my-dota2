import { pickCaptureDevice, type CaptureDevice } from '@shared/mic'

/** 录音约束：单声道 + 回声消除 + 降噪，两条录音腿（对讲 / 训练）共用。 */
export const MIC_CONSTRAINTS: MediaTrackConstraints = { channelCount: 1, echoCancellation: true, noiseSuppression: true }

/** 面板「讲话设备」选中的设备：非空就压过自动挑——用户指名要开谁，就开谁（哪怕会断声）。 */
let preferredDeviceId = ''

export function setMicDevicePreference(deviceId: string): void {
  preferredDeviceId = deviceId
}

/** 记住上次选中的输入端点，下次直接开它。
 *  不能先碰系统默认：默认若是蓝牙耳机，开麦会把整条蓝牙从音乐模式（A2DP）切到通话模式（HFP），
 *  游戏声音彻底断一到两秒；换回真麦克风时再切一次——一次对讲断两下。
 *  先枚举拿不到 label，所以只有「记住上次的选择」能让后续开麦绕开默认设备。 */
const MIC_CACHE_KEY = 'oh-my-dota2.captureDeviceId'

function cachedDeviceId(): string {
  try {
    return localStorage.getItem(MIC_CACHE_KEY) ?? ''
  } catch {
    return ''
  }
}

function rememberDeviceId(deviceId: string): void {
  try {
    if (deviceId) localStorage.setItem(MIC_CACHE_KEY, deviceId)
    else localStorage.removeItem(MIC_CACHE_KEY)
  } catch {
    // 存储不可用就当没有缓存：每次重新探测，不影响录音本身。
  }
}
/**
 * 拿一路「能录到人声」的麦克风。
 *
 * 系统默认输入被设成虚拟声卡（VB-Cable 的 CABLE Output）时，直接 getUserMedia 只会录到静音——
 * 对讲报「没有检测到语音（RMS 0.0000）」。设备 label 只有授权后才可见，所以先按默认开一次拿到权限，
 * 再枚举、判断默认那路是不是虚拟线；是就换成真实麦克风重开一次。换不到就沿用第一路，不阻断录音。
 */
export async function openMicStream(): Promise<MediaStream> {
  if (preferredDeviceId) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...MIC_CONSTRAINTS, deviceId: { exact: preferredDeviceId } }
      })
    } catch {
      // 指定的设备这会儿不在（拔了 / 没连上）：这次退回自动，设置本身不动。
      console.log('MIC_PREF_FAIL', JSON.stringify({ deviceId: preferredDeviceId }))
    }
  }
  const remembered = cachedDeviceId()
  if (remembered) {
    try {
      return await navigator.mediaDevices.getUserMedia({
        audio: { ...MIC_CONSTRAINTS, deviceId: { exact: remembered } }
      })
    } catch {
      // 记着的设备不在了（拔掉 / 换了机器）：忘掉它，按下面重新探测。
      rememberDeviceId('')
    }
  }
  const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS })
  try {
    const current = stream.getAudioTracks()[0]?.getSettings().deviceId ?? ''
    const devices: CaptureDevice[] = (await navigator.mediaDevices.enumerateDevices())
      .filter((device) => device.kind === 'audioinput')
      .map((device) => ({ deviceId: device.deviceId, label: device.label }))
    const pick = pickCaptureDevice(devices)
    if (!pick) return stream
    if (pick === current) {
      rememberDeviceId(current)
      return stream
    }
    const next = await navigator.mediaDevices.getUserMedia({ audio: { ...MIC_CONSTRAINTS, deviceId: { exact: pick } } })
    stream.getTracks().forEach((track) => track.stop())
    const label = devices.find((device) => device.deviceId === pick)?.label ?? ''
    console.log('MIC_SWITCH', JSON.stringify({ from: current, to: pick, label }))
    rememberDeviceId(pick)
    return next
  } catch (err) {
    // 换设备失败不致命：系统默认那路可能是用户故意选的，宁可录静音也别让对讲直接不可用。
    console.log('MIC_SWITCH_FAIL', JSON.stringify({ error: String(err) }))
    return stream
  }
}

/**
 * 启动时先跑一次选设备再立刻关掉。
 * 本机第一次开麦可能打中系统默认的蓝牙耳机（切 A2DP→HFP 会断游戏声音），
 * 把这唯一一次代价挪到开局前，之后全靠上面记住的设备直连。
 */
export function warmMic(preferred?: string): void {
  if (preferred !== undefined) preferredDeviceId = preferred
  void openMicStream()
    .then((stream) => stream.getTracks().forEach((track) => track.stop()))
    .catch(() => undefined)
}

/**
 * 这条流实际开在哪台设备上：`label|deviceId 前 8 位`。
 * 日志里认 id 没有意义（它按 origin 加盐，和 settings 里存的那串对不上），人眼认的是名字。
 */
export async function describeCaptureDevice(stream: MediaStream): Promise<string> {
  const track = stream.getAudioTracks()[0]
  const id = track?.getSettings().deviceId ?? ''
  const fallback = track?.label ?? ''
  if (!id) return fallback
  const all = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[])
  const hit = all.find((device) => device.deviceId === id)
  return `${hit?.label || fallback || '未知设备'}|${id.slice(0, 8)}`
}
