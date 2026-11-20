/**
 * 麦克风健康判定（#96）：设备掉线、电平条、能不能进语音链。
 *
 * 为什么单独一个共享模块：掉线判定和「能不能送 ASR」是关卡不是感觉——
 * 探针要钉「静音设备在链跑之前报出来、无帧的录音永远进不了 ASR」，
 * 采集端（浮层/面板）只负责拿事实来问，答案只有一个。
 */

/** 开麦那一刻拿到的轨道状态。 */
export interface StreamFacts {
  /** MediaStreamTrack.readyState：live 才是活的，ended = 设备没了。 */
  readyState: 'live' | 'ended' | string
  /** MediaStreamTrack.muted：设备静音开关 / 系统静音压着，也是「这路现在没声音」。 */
  muted: boolean
}

/**
 * 这一路麦克风还能不能拿来录音。
 * 只判「开麦瞬间」的事实：轨道不是 live（设备拔出/驱动死了）或正被静音，都算掉线——
 * 这就是为什么「掉线」报在**链跑之前**：还没等你说第一句话，开麦那一刻就知道这路是坏的。
 */
export function micDead(facts: StreamFacts): boolean {
  return facts.readyState !== 'live' || facts.muted === true
}

/** 掉线/静音的提示语：设备名带不带都行，人话必须说清「去改设备或授权」。 */
export function micDeadNotice(label: string): string {
  const who = label ? `（${label}）` : ''
  return `麦克风没声音${who}：设备被拔出、静音或没授权——开麦失败，请换设备或检查 Windows 隐私设置`
}

/**
 * 录音电平 → 0..100 的条。RMS 是线性幅度，人耳/视觉要对数感：
 * 0.012（静音阈值）≈ 14%，0.05 ≈ 60%，0.1 以上顶满。
 */
export function levelPercent(rms: number): number {
  if (!Number.isFinite(rms) || rms <= 0) return 0
  if (rms >= 0.1) return 100
  return Math.min(100, Math.round(rms * 1200))
}

/** 能不能把这条录音送进语音链（识别 → 翻译 → 声出）。 */
export function shouldRunChain(input: { ok: boolean; frames: number }): boolean {
  // 双保险：采集端的判定（ok）说了算，帧数再兜一次底——0 帧 = 没录到任何东西，绝不进链。
  return input.ok === true && input.frames > 0
}

/** 掉线是哪一种：轨道没了（拔线/驱动死）还是被静音压着。 */
export type MicDeadReason = 'ended' | 'muted'

/**
 * 一路麦克风的现状：面板画电平条和掉线提示都只问这一个形状。
 * 由采集端（浮层）边录边报，主进程转手广播；面板不自己开麦。
 */
export interface MicHealthEvent {
  recording: boolean
  /** 0..100：levelPercent 的结果，面板只画不换算。 */
  level: number
  dead: boolean
  reason: MicDeadReason | null
  /** 设备名（`描述` 里的 label 部分），掉线提示要带上去。 */
  label: string
}
