/**
 * 对讲计时（voice-reply-latency）：一句话从「识别开始」到「整句播完」拆成五段，
 * 每段由自己的执行点记账，浮层、面板和日志只认这一个形状。
 *
 * 缺段一律 null——「没量到」和「0 毫秒」是两件事，界面上一律画成 '-'。
 * 术语按 GLOSSARY：识别 = ASR；译文 = 翻译结果；首音 = 第一段合成音频到手；起播 = 真正出声。
 */
export interface VoiceChainTiming {
  /** ASR：主进程收到 WAV 到识别结果返回。 */
  asrMs: number | null
  /** 翻译：识别文本交给模型到译文回来。 */
  translateMs: number | null
  /** 首音：译文交给合成到第一段音频到手（GV 的每请求地板就在这一段）。 */
  firstAudioMs: number | null
  /** 起播：首段音频到手到真正出声（输出设备路由 + 说话键）。 */
  playStartMs: number | null
  /** 整句：起播到最后一秒音频播完。 */
  speakMs: number | null
  /** 总计：识别开始到起播——队友听到第一声之前的全部等待。 */
  totalMs: number | null
}

/** 毫秒给人看：一秒以下给整数毫秒，以上给一位小数的秒。 */
export function formatMs(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return '-'
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`
}

/** 面板记录行的完整拆解；没量到的段不出现在串里，全缺返回 null（那一行就不画）。 */
export function formatChainTiming(timing: VoiceChainTiming | null | undefined): string | null {
  if (!timing) return null
  const legs: [string, number | null][] = [
    ['识别', timing.asrMs],
    ['译', timing.translateMs],
    ['首音', timing.firstAudioMs],
    ['起播', timing.playStartMs],
    ['播完', timing.speakMs]
  ]
  const parts = legs.filter(([, ms]) => ms !== null && Number.isFinite(ms)).map(([label, ms]) => `${label} ${formatMs(ms)}`)
  return parts.length > 0 ? parts.join(' · ') : null
}

/** 浮层那一行只给最该看的数字：从识别开始到出声，一共等了多久。 */
export function formatChainTotal(timing: VoiceChainTiming | null | undefined): string | null {
  if (!timing || timing.totalMs === null || !Number.isFinite(timing.totalMs)) return null
  return `起播共 ${formatMs(timing.totalMs)}`
}
