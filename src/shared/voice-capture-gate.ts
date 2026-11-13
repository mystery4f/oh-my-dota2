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

/** 静音阈值：whisper 对纯静音会幻觉出文本，先量 RMS 再决定送不送。 */
export const SILENCE_RMS = 0.012

/** 拒绝理由只有两种，别在调用点再拼字符串。 */
export type CaptureRejection = 'too-short' | 'silent'

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

export function judgeCapture(input: { frames: number; sampleRate: number; rms: number }): CaptureVerdict {
  const ms = input.sampleRate > 0 ? (input.frames / input.sampleRate) * 1000 : 0
  if (ms < MIN_SPEECH_MS) {
    return {
      ok: false,
      reason: 'too-short',
      line: '录音太短，已忽略',
      detail: `录音太短（${Math.round(ms)} 毫秒，不足 ${MIN_SPEECH_MS} 毫秒）`
    }
  }
  if (input.rms < SILENCE_RMS) {
    return {
      ok: false,
      reason: 'silent',
      line: `没有检测到语音（音量 RMS ${input.rms.toFixed(4)}）`,
      detail: `没有检测到语音（RMS ${input.rms.toFixed(4)} < ${SILENCE_RMS}）`
    }
  }
  return { ok: true, reason: null, line: '', detail: `可以识别（${Math.round(ms)} 毫秒，RMS ${input.rms.toFixed(4)}）` }
}
