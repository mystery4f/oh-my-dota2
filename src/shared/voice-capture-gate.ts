/**
 * 一段对讲录音「算不算话」的判定。
 *
 * 为什么要单独一个共享模块：这条判定以前长在浮层组件里（渲染层的闭包里），
 * 阈值和提示语都是就地写的，主进程的探针、面板的日志都够不着，改一次阈值要凭肉眼回归。
 * 现在它只有输入（帧数、采样率、RMS）和一句理由，采集端只负责喂数据、画结果。
 *
 * 边界：开麦失败（松开赶在开麦完成之前、设备打不开）属于**采集过程**，不是这段录音的内容，
 * 所以留在采集端，不在这里。这里只回答「这段声音能不能送去识别」。
 */

/** 短于这个时长的录音直接丢：多半是误触。 */
export const MIN_SPEECH_MS = 300

/** 静音阈值：whisper 对纯静音会幻觉出文本，先量音量再决定送不送。判的是「最响的那 100 毫秒」，不是整段平均。 */
export const SILENCE_RMS = 0.012

/**
 * 数字静音：整段的峰值窗都低于这个数，说明这一路根本没有声音进来（端点选错、系统没授权、
 * 设备静音键按着）。和「说话太轻」分开：前者要去改设备，后者只要再说一遍。
 * 实测：真实说话的录音最安静的一条峰值窗也有 0.078，所以 0.0005 离人声很远，不会误伤。
 */
export const NO_SIGNAL_RMS = 0.0005

/**
 * 判音量用的窗长。整段平均会被前后的静音拉低——按住两秒只说一个词，平均值可能落在阈值下，
 * 于是「说了话」被判成「没检测到语音」。按窗取最大值，问的是「这段里有没有一下足够响」。
 */
export const PEAK_WINDOW_MS = 100

/**
 * 麦闲置租约：松开之后麦克风再留这么久，下一次按下即刻可用。
 *
 * 为什么需要它：getUserMedia 要几百毫秒到一秒多（列设备、切设备时更久），
 * 而按住说话的一次按下常常只有两三百毫秒——松开赶在开麦完成之前，这条录音就只能丢，
 * 观感正是「热键有时没反应，得按久一点」。留一路挂起的流，第二次按下就没有这段延迟。
 * 两分钟是「一局里两次说话之间」的量级；超时就关掉，不让麦克风一直开着。
 */
export const MIC_WARM_LEASE_MS = 120_000

/** 挂起的流还能不能用：租约没过期，轨道还活着（设备被拔掉时 readyState 会变 ended）。 */
export function canReuseMic(ageMs: number, readyState: string | undefined): boolean {
  return ageMs >= 0 && ageMs < MIC_WARM_LEASE_MS && readyState === 'live'
}

/** 拒绝理由只有这三种，别在调用点再拼字符串。 */
export type CaptureRejection = 'too-short' | 'silent' | 'no-signal'

export interface CaptureVerdict {
  /** 能送去识别。 */
  ok: boolean
  /** 不能时的理由；能送时是 null。 */
  reason: CaptureRejection | null
  /** 浮层阶段行上给用户看的一句话。 */
  line: string
  /** 日志与面板用的细节：带上实测值，事后能算清为什么丢了。 */
  detail: string
}

/** 按块算整体音量（RMS）。块就是 recorder 交回来的 PCM 片段。 */
export function captureLevel(chunks: readonly Float32Array[], frames: number): number {
  if (frames <= 0) return 0
  let energy = 0
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) energy += chunk[i] * chunk[i]
  }
  return Math.sqrt(energy / frames)
}

/**
 * 最响的那一窗的音量（RMS）。窗口按 PEAK_WINDOW_MS 切，末尾不足一窗也单独算——
 * 一个很短的「嗯」可能整段都落在尾巴上。
 */
export function capturePeak(chunks: readonly Float32Array[], frames: number, sampleRate: number): number {
  if (frames <= 0 || sampleRate <= 0) return 0
  const size = Math.max(1, Math.round((sampleRate * PEAK_WINDOW_MS) / 1000))
  let best = 0
  let energy = 0
  let count = 0
  for (const chunk of chunks) {
    for (let i = 0; i < chunk.length; i += 1) {
      energy += chunk[i] * chunk[i]
      count += 1
      if (count < size) continue
      const rms = Math.sqrt(energy / count)
      if (rms > best) best = rms
      energy = 0
      count = 0
    }
  }
  if (count > 0) {
    const rms = Math.sqrt(energy / count)
    if (rms > best) best = rms
  }
  return best
}

export function judgeCapture(input: { frames: number; sampleRate: number; rms: number; peak: number }): CaptureVerdict {
  const ms = input.sampleRate > 0 ? (input.frames / input.sampleRate) * 1000 : 0
  if (ms < MIN_SPEECH_MS) {
    return {
      ok: false,
      reason: 'too-short',
      line: '录音太短，已忽略',
      detail: `录音太短（${Math.round(ms)} 毫秒，不足 ${MIN_SPEECH_MS} 毫秒）`
    }
  }
  if (input.peak < NO_SIGNAL_RMS) {
    return {
      ok: false,
      reason: 'no-signal',
      line: '麦克风没有声音：检查输入设备',
      detail: `麦克风没有声音（最响 ${PEAK_WINDOW_MS} 毫秒 ${input.peak.toFixed(5)}，整段 ${input.rms.toFixed(5)}）`
    }
  }
  if (input.peak < SILENCE_RMS) {
    return {
      ok: false,
      reason: 'silent',
      line: `没有检测到语音（音量 ${input.peak.toFixed(4)}，低于 ${SILENCE_RMS}）`,
      detail: `没有检测到语音（最响 ${PEAK_WINDOW_MS} 毫秒 ${input.peak.toFixed(4)} < ${SILENCE_RMS}，整段 ${input.rms.toFixed(4)}）`
    }
  }
  return {
    ok: true,
    reason: null,
    line: '',
    detail: `可以识别（${Math.round(ms)} 毫秒，最响 ${input.peak.toFixed(4)}，整段 ${input.rms.toFixed(4)}）`
  }
}

/**
 * 浮层那一行最终显示什么：设备一个信号都没有的时候，把设备名一起摆出来——
 * 用户要改的是系统输入（换设备、给权限），不是对着它再喊一遍。
 * 只是声音太轻时不提设备：那句话说了等于没说。
 */
export function rejectLine(verdict: CaptureVerdict, micLabel: string): string {
  if (verdict.reason !== 'no-signal' || micLabel === '') return verdict.line
  return `${verdict.line}（${micLabel}）`
}
