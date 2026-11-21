/**
 * 看图的门槛与判据（#135）：热键截一帧、问一次、把答案放回面板。
 *
 * 三件必须在探针里成立的事：这次要发的 payload 长什么样；当前 provider 到底能不能收图；
 * 失败时用户看到的是消息而不是空面板。图片本身绝不落盘，所以这里只有尺寸与字节数。
 */

/** 一次截屏的元数据（图片只在内存里走一趟，不写盘、不进 logs）。 */
export interface VisionShot {
  width: number
  height: number
  bytes: number
}

/** 一次提问的结果：成功给的原文、用的哪个模型、花了多久；失败只填 error。 */
export interface VisionAnswer {
  ok: boolean
  text: string
  model: string
  providerId: string
  ms: number | null
  shot: VisionShot | null
  error?: string
}

/** 面板先问「能不能看」，而不是等按下热键才失败。reason 为空 = 能看。 */
export interface VisionReadiness {
  ready: boolean
  model: string
  reason: string | null
}

/**
 * 提示词：要的是「能立刻行动的判断」，不是截图说明文。
 * 点名要位置，是因为玩家下一步要动；要求「看不清就说看不清」，是因为模型的默认行为是编。
 */
export const VISION_PROMPT = [
  '你在看一张 Dota 2 的实时截图，用简体中文回答，说人话，不要解释你在做什么。',
  '',
  '格式：',
  '- 第一行一句总判断：现在最该干什么。',
  '- 然后 3 到 5 条，每条以「- 」开头，点出位置（上路 / 中路 / 下路 / 野区 / 肉山 / 己方高地）。',
  '- 看不到或不确定就直说「看不清」，不要猜：编一个位置比不回答更糟。'
].join('\n')

/**
 * 模型名里能看出「收图」的线索。这是个名字启发式，不是能力查询——所以判不准时
 * 面板要说「按名字看它不收图」，而不是断言「这个模型不支持图片」。
 */
export const VISION_MODEL_HINTS = /vision|vl\b|omni|multimodal|gpt-4o|gpt-4\.1|gpt-5|glm-4v|claude|gemini|qvq/i

export function isVisionModel(model: string): boolean {
  return VISION_MODEL_HINTS.test(model.trim())
}

/**
 * 能不能看图：没有 key 先拦（换模型也白搭），再看模型名。
 * 已配置但名字不像视觉模型时给的是「怎么改」，不是「不支持」。
 */
export function judgeVisionReadiness(provider: {
  id: string
  model: string
  apiKey: string
}): VisionReadiness {
  const model = provider.model.trim()
  if (!provider.apiKey.trim() && provider.id !== 'ollama') {
    return { ready: false, model, reason: '还没填 API key：对话页填一个，才能问模型' }
  }
  if (!model) return { ready: false, model, reason: '还没选模型：对话页选一个能看图的' }
  if (!isVisionModel(model)) {
    return {
      ready: false,
      model,
      reason: '当前模型「' + model + '」按名字看它不收图：在对话页换一个能看图的模型（名字里通常带 vl / vision / omni）'
    }
  }
  return { ready: true, model, reason: null }
}

/** 面板上那一行：成功说清用了哪个模型和多久，失败原样给出原因。 */
export function visionLine(answer: VisionAnswer): string {
  if (!answer.ok) return answer.error ?? '看图失败，原因不明'
  const size = answer.shot ? answer.shot.width + '×' + answer.shot.height : '截图'
  const ms = answer.ms === null ? '' : ' · 用时 ' + (answer.ms / 1000).toFixed(1) + ' 秒'
  return size + ms + ' · ' + answer.model
}

/** 截图像素与体积的说明，面板用它让「一次问答大概多少钱」有据可依。 */
export function visionShotLine(shot: VisionShot): string {
  return shot.width + '×' + shot.height + ' · ' + (shot.bytes / 1024 / 1024).toFixed(2) + ' MB（只在内存里，不落盘）'
}
