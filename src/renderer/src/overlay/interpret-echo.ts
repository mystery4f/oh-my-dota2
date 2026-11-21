/**
 * 同声模式下，把刚才那句中文原样放回自己的耳朵（票 128）。
 *
 * 为什么放原始录音而不是再合成一遍中文：用户要确认的是「送出去的是不是这句话」，
 * 原始录音就是那句话本身；再合成一遍既多一次模型调用，又把回放延迟叠进链条里。
 * 为什么只在本机放：英文已经灌进游戏话筒，中文再进一次就是两种语言同时说。
 * 为什么掐上一句：连按热键时听到的必须是最后一句，两句叠着放谁也听不清。
 */

let current: HTMLAudioElement | null = null

/** 上一句还在放就停掉（开新一句、或同声被关掉时都调）。 */
export function stopInterpretEcho(): void {
  if (current === null) return
  const audio = current
  current = null
  audio.onended = null
  audio.pause()
  audio.src = ''
}

/** `wav` 是 encodeWav16k 的 base64：data URL 直接喂给 Audio，不用管对象 URL 的生命周期。 */
export function playInterpretEcho(wav: string): void {
  if (wav === '') return
  stopInterpretEcho()
  const audio = new Audio(`data:audio/wav;base64,${wav}`)
  current = audio
  const done = (): void => {
    if (current === audio) current = null
  }
  audio.onended = done
  // 播放被拒（没有输出设备 / 用户手势限制）时安静收场：回放是锦上添花，不能挡住识别那条链。
  void audio.play().catch(done)
}
