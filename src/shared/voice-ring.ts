/**
 * 对讲三态指示环（#94）：空闲 / 录音中 / 朗读中。
 *
 * 为什么是一个共享纯缝而不是直接写在组件里：这三个状态分布在两个模块（录音在 voice-capture，
 * 朗读在 speech），如果每个组件各自判断一遍，迟早出现「环说空闲、行说播放中」的对不上。
 * 判据只写一次，渲染层只负责画。
 *
 * 「不许只靠颜色区分」是验收线：三种状态的**形状**不同——空心细环 / 实心圆 / 两道波纹，
 * 灰度截图也能分清；颜色只是加强。
 */
export type VoiceRingState = 'idle' | 'recording' | 'speaking'

/** 两个原始信号：谁在响。录音优先——按着热键时最要紧的是「我正在被录」。 */
export interface VoiceRingSignal {
  recording: boolean
  speaking: boolean
}

export type VoiceRingShape = 'hollow' | 'filled' | 'waves'

export interface VoiceRingView {
  state: VoiceRingState
  /** 中文短标签；和形状一起出现，不靠颜色也读得懂。 */
  label: string
  shape: VoiceRingShape
  /** 要不要呼吸动画（录音与朗读都要动，空闲不动——静止的东西不抢注意力）。 */
  pulse: boolean
  /** 读屏与悬停都能读到的整句。 */
  aria: string
}

/** 录音优先：按住热键的瞬间，用户要看的是「在录」，不是「上一句还在念」。 */
export function voiceRingState(signal: VoiceRingSignal): VoiceRingState {
  if (signal.recording) return 'recording'
  if (signal.speaking) return 'speaking'
  return 'idle'
}

export function voiceRingView(signal: VoiceRingSignal): VoiceRingView {
  const state = voiceRingState(signal)
  if (state === 'recording') {
    return { state, label: '录音中', shape: 'filled', pulse: true, aria: '正在录音：松开（或再按一次）就识别' }
  }
  if (state === 'speaking') {
    return { state, label: '朗读中', shape: 'waves', pulse: true, aria: '正在朗读译文' }
  }
  return { state, label: '空闲', shape: 'hollow', pulse: false, aria: '空闲：按对讲热键开始录音' }
}
