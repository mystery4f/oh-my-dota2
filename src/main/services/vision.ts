import { desktopCapturer, screen } from 'electron'
import { errorMessage } from '@shared/errors'
import { judgeVisionReadiness, VISION_PROMPT, type VisionAnswer, type VisionReadiness, type VisionShot } from '@shared/vision'
import type { ProviderConfig } from '@shared/ipc'
import { loadSettings } from './settings'
import { chatCompletion, type ChatMessage } from './providers/openai-compat'

/**
 * 看图（#135）：截一帧 → 问一次 → 给答案。
 *
 * 三条硬规矩：
 * - 图片只在内存里过一趟。不写盘、不写 logs（票面 Acceptance 有一条专门钉这个）。
 * - 用户主动触发，绝不轮询：一次截图就是一次调用，账单由用户自己按下热键决定。
 * - 失败给消息，不给空面板。「看不到画面」「模型不收图」「超时」是三句不同的话。
 */

/** 发给模型的宽度上限：1280 已经够看清小地图和装备栏，再大只是加钱。 */
const SHOT_WIDTH = 1280
/** 一张 PNG 撑到这个体积说明缩图没生效，宁可换更小的尺寸也不要发出去。 */
const MAX_SHOT_BYTES = 4 * 1024 * 1024

export interface CapturedFrame {
  /** `data:image/png;base64,...`，只用于这一次请求。 */
  dataUrl: string
  shot: VisionShot
}

/**
 * 截主屏一帧。用 desktopCapturer（不是常驻流）：这个东西一分钟调一次都嫌多，
 * 建流反而要处理它自己的生命周期。
 */
export async function captureScreen(): Promise<CapturedFrame> {
  const primary = screen.getPrimaryDisplay()
  const scale = Math.min(1, SHOT_WIDTH / Math.max(1, primary.size.width))
  const width = Math.max(320, Math.round(primary.size.width * scale))
  const height = Math.max(180, Math.round(primary.size.height * scale))
  // 第一帧偶尔是空的（桌面刚切换、会话还没解锁），一次重试比直接报错更接近用户预期；
  // 重试还是空就是真的拿不到桌面，那就把原因说出来。
  let image = await grabFrame(width, height, primary.id)
  if (image.isEmpty()) {
    await new Promise((resolve) => setTimeout(resolve, 400))
    image = await grabFrame(width, height, primary.id)
  }
  if (image.isEmpty()) throw new Error('截不到画面：这一帧是空的（受保护窗口、桌面锁着，或这个会话拿不到桌面）')
  const size = image.getSize()
  const png = image.toPNG()
  if (png.length > MAX_SHOT_BYTES) {
    throw new Error(
      '截到的图太大（' + (png.length / 1024 / 1024).toFixed(1) + ' MB）：先把游戏切到窗口模式再试'
    )
  }
  return {
    dataUrl: 'data:image/png;base64,' + png.toString('base64'),
    shot: { width: size.width, height: size.height, bytes: png.length }
  }
}

/**
 * 这一次要发出去的 payload：一条消息、两块内容（提示词 + 图）。
 * 单独拿出来是因为「形状」是票面 Acceptance 要钉的东西，探针必须能直接断言它。
 */
export function buildVisionMessages(dataUrl: string): ChatMessage[] {
  return [
    {
      role: 'user',
      content: [
        { type: 'text', text: VISION_PROMPT },
        { type: 'image_url', image_url: { url: dataUrl } }
      ]
    }
  ]
}

/** 取主屏这一帧；找不到对应屏幕就退回第一块屏幕（多显示器时至少不是空手）。 */
async function grabFrame(width: number, height: number, displayId: number): Promise<Electron.NativeImage> {
  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width, height },
    fetchWindowIcons: false
  })
  const source = sources.find((item) => item.display_id === String(displayId)) ?? sources[0]
  if (!source) throw new Error('截不到画面：系统没有给出任何屏幕')
  return source.thumbnail
}

/** 面板先问这个，而不是等按下热键才失败。 */
export function visionReadiness(): VisionReadiness {
  return judgeVisionReadiness(loadSettings().provider)
}

/** 一次提问：截不到就报截不到，模型不回就报模型不回，两种都不许变成空面板。 */
export async function askScreen(provider: ProviderConfig = loadSettings().provider): Promise<VisionAnswer> {
  const base = { text: '', model: provider.model, providerId: provider.id, shot: null as VisionShot | null }
  const readiness = judgeVisionReadiness(provider)
  if (!readiness.ready) return { ...base, ok: false, ms: null, error: readiness.reason ?? '当前模型不能看图' }
  let frame: CapturedFrame
  try {
    frame = await captureScreen()
  } catch (err) {
    return { ...base, ok: false, ms: null, error: errorMessage(err) }
  }
  const started = Date.now()
  try {
    const text = await chatCompletion({
      provider,
      messages: buildVisionMessages(frame.dataUrl),
      temperature: 0.2,
      maxTokens: 700,
      timeoutMs: 45_000
    })
    return { ...base, ok: true, text, ms: Date.now() - started, shot: frame.shot }
  } catch (err) {
    return { ...base, ok: false, ms: Date.now() - started, shot: frame.shot, error: '模型没答上来：' + errorMessage(err) }
  }
}
