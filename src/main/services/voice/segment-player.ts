import type { VoiceOutEndedReport, VoiceOutReadyReport } from '@shared/ipc'
import { MIN_SPEAK_MS, PTT_MARGIN_MS, pttWatchdogMs, pttWindow } from '@shared/voice-out'
import { getPttKeySender } from '../input/ptt-key'
import { getVoiceOutWindow } from '../../windows/voice-out'

/** 窗口侧枚举设备 + setSinkId + 解码读时长的总预算：必须盖过最坏路径——页面加载 8 s（PAGE_LOAD_TIMEOUT_MS）+ 页面内读音频时长 8 s = 16 s。 */
const READY_TIMEOUT_MS = 17_000

/** 起播那一刻的事实：调用方拿它写自己那条腿的日志（引擎/音色由调用方补）。 */
export interface SegmentSpeakInfo {
  requestId: number
  bytes: number
  durationMs: number | null
  sinkLabel: string
  keyHeld: boolean
  holdMs: number
}

/** 一段音频的播放结果。失败原因按阶段分开：窗口没就绪、结束事件超时、播放失败。 */
export type SegmentOutcome =
  | { kind: 'played'; durationMs: number | null; hint: string | null }
  | { kind: 'not-ready'; error: string; hint: string | null }
  | { kind: 'timeout'; durationMs: number | null; hint: string | null }
  | { kind: 'failed'; error: string | null; durationMs: number | null; hint: string | null }

export interface SegmentPlayerOptions {
  /** 说话音频的输出设备 id（空串 = 系统默认）。 */
  device: string
  /** 本机监听：同一段音频开两路——虚拟声卡那路给游戏，默认输出那路给人耳（调试期用）。 */
  monitorLocal: boolean
  /** 测试模式：只放音频、不模拟按键，键位逻辑整段跳过。 */
  testMode: boolean
  /** 说话键的 VK；null = 键名无法识别，原因经 onKeyError 报给调用方。 */
  keyVk: number | null
  /** 回落设备时的一行提示：两条腿的规则一样（ready.fallback && hint），所以留在这里。 */
  onHint?: (text: string) => void
  /** 正要起播（键已按下）时回调一次，供各自写日志。 */
  onSpeak?: (info: SegmentSpeakInfo) => void
  /** 说话键按下失败：话照播，但原因要落到该腿自己的日志里。 */
  onKeyError?: (error: string, requestId: number) => void
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function waitReady(requestId: number, timeoutMs: number): Promise<VoiceOutReadyReport | null> {
  const window = getVoiceOutWindow()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      offReady()
      offEnded()
      resolve(null)
    }, timeoutMs)
    const offReady = window.onReady((report) => {
      if (report.requestId !== requestId) return
      clearTimeout(timer)
      offEnded()
      resolve(report)
    })
    const offEnded = window.onEnded((report) => {
      // 页面在 READY 之后立刻翻车（解码/播放被拒）：当成 ready=false 处理，别傻等。
      if (report.requestId !== requestId) return
      clearTimeout(timer)
      offReady()
      resolve({ requestId, ok: false, durationMs: report.durationMs, sinkId: '', sinkLabel: '', fallback: false, hint: null, error: report.error })
    })
  })
}

function waitEnded(requestId: number, timeoutMs: number): Promise<VoiceOutEndedReport | null> {
  const window = getVoiceOutWindow()
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      offEnded()
      resolve(null)
    }, timeoutMs)
    const offEnded = window.onEnded((report) => {
      if (report.requestId !== requestId) return
      clearTimeout(timer)
      offEnded()
      resolve(report)
    })
  })
}

/**
 * 一段音频怎么播：等窗口就绪 → 按住说话键（整单只按一次）→ 起播 → 等结束 → 收尾松键。
 *
 * 测试腿与对讲腿此前各写一遍这七步，规则一样却各自为政：按住/松开的时机、头部余量只等一次、
 * 尾巴余量、失败后也要松键——改一处就漏另一处，而漏掉的后果是说话键卡死在频道里。
 * 现在播放只留这一份；两条腿的差别只剩「失败后是一单结束，还是跳过这段继续下一段」，
 * 那是调用方的决定，不属于播放本身。
 */
export class SegmentPlayer {
  private keyHeld = false
  private keyError: string | null = null
  private startedAny = false
  private releaseMs = PTT_MARGIN_MS

  constructor(private readonly options: SegmentPlayerOptions) {}

  /** 说话键这条链路上的失败原因（按下或松开）；null = 键一直正常。 */
  get error(): string | null {
    return this.keyError
  }

  async play(requestId: number, audio: Buffer, mime: string): Promise<SegmentOutcome> {
    const window = getVoiceOutWindow()
    const readyPromise = waitReady(requestId, READY_TIMEOUT_MS)
    await window.play({
      requestId,
      audioBase64: audio.toString('base64'),
      audioMime: mime,
      requestedDevice: this.options.device,
      monitorLocal: this.options.monitorLocal
    })
    const ready = await readyPromise
    if (!ready || !ready.ok) {
      return { kind: 'not-ready', error: ready?.error ?? '声出窗口没有就绪（超时）', hint: ready?.hint ?? null }
    }
    if (ready.fallback && ready.hint) this.options.onHint?.(ready.hint)

    const hold = pttWindow(ready.durationMs ?? MIN_SPEAK_MS)
    this.releaseMs = hold.releaseMs
    // 键按上了再报「要播了」：日志里的 keyHeld 是按下那一刻的事实，不是意图。
    await this.pressKeyOnce(requestId)
    this.options.onSpeak?.({
      requestId,
      bytes: audio.length,
      durationMs: ready.durationMs,
      sinkLabel: ready.sinkLabel,
      keyHeld: this.keyHeld,
      holdMs: hold.holdMs
    })
    if (!this.startedAny) await delay(hold.leadMs)
    this.startedAny = true
    window.start(requestId)
    const ended = await waitEnded(requestId, pttWatchdogMs(hold))
    if (!ended) return { kind: 'timeout', durationMs: ready.durationMs, hint: ready.hint }
    if (!ended.ok) {
      return {
        kind: 'failed',
        error: ended.error ?? null,
        durationMs: ended.durationMs ?? ready.durationMs,
        hint: ready.hint
      }
    }
    return { kind: 'played', durationMs: ended.durationMs ?? ready.durationMs, hint: ready.hint }
  }

  /** 收尾：尾巴余量后松开说话键。任何提前 return / 抛错的路径都必须调它——键卡死比这句没播出严重。 */
  async finish(): Promise<string | null> {
    if (this.keyHeld) await delay(this.releaseMs)
    return this.releaseKey()
  }

  /** 整单只按一次：中途松键频道会露缝；键按下失败也不再重试，避免每段都报一次同样的错。 */
  private async pressKeyOnce(requestId: number): Promise<void> {
    if (this.options.testMode || this.keyHeld || this.keyError) return
    const vk = this.options.keyVk
    if (vk === null) {
      this.keyError = '说话键无法识别（检查设置里的说话键）'
    } else {
      const down = await getPttKeySender().down(vk)
      if (down.ok) this.keyHeld = true
      else this.keyError = down.error ?? '说话键按下失败'
    }
    if (this.keyError) this.options.onKeyError?.(this.keyError, requestId)
  }

  private async releaseKey(): Promise<string | null> {
    if (!this.keyHeld) return this.keyError
    this.keyHeld = false
    const vk = this.options.keyVk
    if (vk === null) return this.keyError
    const up = await getPttKeySender().up(vk)
    if (!up.ok && !this.keyError) this.keyError = up.error ?? '说话键松开失败'
    return this.keyError
  }
}
