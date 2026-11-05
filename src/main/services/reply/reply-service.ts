import { clipboard } from 'electron'
import {
  type InPlaceResult,
  type ReplyResult,
  type ReplySendResult,
  type ReplyTone,
  type VoiceReplyResult
} from '@shared/ipc'
import { decideVoiceOutReply } from '@shared/voice-out'
import { decideInPlaceDelivery, inplaceFailureLine, pickInPlaceDraft } from '@shared/inplace'
import { loadSettings } from '../settings'
import { abortTranslation, translateReply } from '../session/durable-translator'
import { buildSayTeamCommand, getConsoleSender } from '../input/console-send'
import { getChatSender, normalizeChatLine } from '../input/chat-send'
import { getInPlaceSender } from '../input/chat-inplace'
import { getVoiceOutService } from '../voice/voice-out'
import { getOverlayManager } from '../../windows/overlay'

/**
 * 回复链深模块（#28）：草稿 → 翻译 → 规范化 → 送达，四条腿共享同一段决策。
 * ipc.ts 只剩 handler 接线；换送达方式（剪贴板 / 按键 / 原地改写 / 声出）都在这里改。
 */

/**
 * 语音对讲一键到底（票 05）：识别文本 → prod 会话翻译（zh→en，复用 replyTone）→
 * 译文进剪贴板 → 声出（按设置的声出引擎 → 所选输出 → 自动按住说话键）。
 * 识别为空 / 翻译失败 / 合成失败一律静默跳过：绝不回退系统嗓子，也不退文出，
 * 浮层错误行由渲染层按 stage 画。
 */
export async function voiceReply(transcript: string): Promise<VoiceReplyResult> {
  const settings = loadSettings()
  const recognized = String(transcript ?? '').trim()
  if (decideVoiceOutReply({ recognized, translated: null }).skip === 'empty-recognition') {
    return { translated: null, spoken: false, stage: 'recognize', error: '未识别到语音' }
  }
  // 只看识别（测口音/调模型）：转写完就停，翻译、剪贴板、声出、按键全跳过。
  if (settings.voiceTranscribeOnly) {
    return { translated: null, spoken: false, stage: 'skipped', error: null }
  }
  let translated: string | null
  try {
    translated = await translateReply(settings.provider, recognized, settings.replyTone)
  } catch (err) {
    return {
      translated: null,
      spoken: false,
      stage: 'translate',
      error: err instanceof Error ? err.message : String(err)
    }
  }
  const plan = decideVoiceOutReply({ recognized, translated })
  if (!plan.speak) {
    return {
      translated: null,
      spoken: false,
      stage: 'translate',
      error: plan.skip === 'empty-translation' ? '翻译结果为空' : '翻译失败'
    }
  }
  clipboard.writeText(plan.text)
  const spoken = await getVoiceOutService().speakReply(plan.text)
  return {
    translated: plan.text,
    spoken: spoken.spoken,
    stage: spoken.spoken ? null : 'voice-out',
    error: spoken.error
  }
}

export async function sendReply(text: string): Promise<ReplySendResult> {
  const settings = loadSettings()
  const draft = text.trim()
  if (!draft) return { ok: false, draft: '', translated: null, command: null, error: '内容为空' }

  const overlay = getOverlayManager()
  let translated: string | null = null
  try {
    translated = await translateReply(settings.provider, draft, settings.replyTone)
  } catch (err) {
    return {
      ok: false,
      draft,
      translated: null,
      command: null,
      error: err instanceof Error ? err.message : String(err)
    }
  }
  if (!translated) {
    return { ok: false, draft, translated: null, command: null, error: '翻译结果为空' }
  }

  const line = normalizeChatLine(translated)
  if (!line) {
    return { ok: false, draft, translated, command: null, error: '译文没有可发送的英文字符' }
  }
  const command = settings.sendMode === 'console' ? buildSayTeamCommand(translated) : line
  overlay.closeReply(false)
  const sent =
    settings.sendMode === 'console'
      ? await getConsoleSender().send(command, settings.consoleKey)
      : await getChatSender().send(line)
  if (!sent.ok) {
    overlay.openReply()
    return { ok: false, draft, translated, command, error: sent.error ?? '发送失败' }
  }
  return { ok: true, draft, translated, command }
}

/**
 * 正在跑的那条原地直发。
 * 再按一次热键就是「打断它，重读聊天框」：用户按第二次是嫌上一句慢了，
 * 不会想让上一句的译文过几秒再落进聊天框 —— 那正是「翻的是上一条」的来源。
 */
interface InPlaceFlight {
  token: number
  /** 已经从聊天框读走、还没写回的中文：被打断时它是唯一还记得这一句的地方。 */
  draft: string | null
  /** 已经写回聊天框：发出去的句子收不回来，不能再交给下一次当草稿。 */
  sent: boolean
}
let inPlaceFlight: InPlaceFlight | null = null
let inPlaceToken = 0
/**
 * 结束当前这条直发，返回还没写回的那句中文。
 * 同时掐掉还在跑的模型回合：不掐它就一直占着回合锁，重按的那一次照样要排在它后面。
 */
function breakInPlace(): string | null {
  const flight = inPlaceFlight
  if (!flight) return null
  inPlaceFlight = null
  abortTranslation('reply')
  return flight.sent ? null : flight.draft
}

/**
 * 读取游戏聊天框里已经打好但未发送的中文，翻译成英文后粘贴回同一个输入框并回车发送。
 * 全程不切换前台窗口，也不经过控制台。
 */
export async function translateInPlace(): Promise<InPlaceResult> {
  const settings = loadSettings()
  const sender = getInPlaceSender()
  // 单飞行：再按一次热键 = 打断上一次。上一句的中文在 grab 时就被读走、聊天框已经空了，
  // 所以必须把它从被打断的那一次手里接过来 —— 新的 grab 只会拿到 NOCONTENT。
  const orphan = breakInPlace()
  const token = ++inPlaceToken
  const flight: InPlaceFlight = { token, draft: null, sent: false }
  inPlaceFlight = flight
  /** 这一条还是当前那一条吗：被别人取代之后聊天框归新的那一次，这边一概不碰。 */
  const alive = (): boolean => inPlaceFlight?.token === token
  const grabbed = await sender.grab()
  // 过期从「读到这一句」算起：慢在桥启动不该算到翻译头上。
  const grabbedAt = Date.now()
  const pick = pickInPlaceDraft({
    ok: grabbed.ok,
    text: grabbed.text ?? null,
    code: grabbed.code,
    error: grabbed.error,
    orphan
  })
  if (pick.kind === 'fail' || pick.kind === 'empty') {
    return {
      ok: false,
      draft: null,
      translated: null,
      grabMs: grabbed.ms,
      error: pick.kind === 'fail' ? pick.reason : '聊天框里没有可翻译的内容'
    }
  }
  if (!alive()) {
    return { ok: false, draft: pick.draft, translated: null, grabMs: grabbed.ms, error: '已被新的直发打断' }
  }
  const draft = pick.draft
  flight.draft = draft
  /** 失败收场：把中文原样贴回聊天框（不按回车），否则那句中文随 grab 一起消失了。 */
  const restore = async (): Promise<boolean> => {
    if (!alive()) return false
    const back = await sender.replace(draft, { enter: false })
    return back.ok
  }
  const translateStartedAt = Date.now()
  let translated: string | null = null
  let failure: string | null = null
  try {
    translated = await translateReply(settings.provider, draft, settings.replyTone, { alive })
  } catch (err) {
    failure = err instanceof Error ? err.message : String(err)
  }
  const translateMs = Date.now() - translateStartedAt
  const delivery = decideInPlaceDelivery({
    cancelled: !alive(),
    line: translated === null ? null : normalizeChatLine(translated),
    elapsedMs: Date.now() - grabbedAt
  })
  // 被新的直发取代：不写回、不回贴、也不报错，新的那一次会给用户答案。
  if (delivery.action === 'abandon') {
    return { ok: false, draft, translated: null, grabMs: grabbed.ms, translateMs, error: delivery.reason }
  }
  if (delivery.action === 'restore') {
    const restored = await restore()
    const reason = failure !== null && translated === null ? failure : delivery.reason
    getOverlayManager().flashHint(inplaceFailureLine({ reason, restored }))
    return { ok: false, draft, translated, grabMs: grabbed.ms, translateMs, restored, error: reason }
  }
  // 从这里起这句英文可能已经粘上并回车：之后被打断也不能再回贴中文，否则聊天框里多一句。
  flight.sent = true
  const sent = await sender.replace(delivery.line)
  if (!sent.ok) {
    const restored = await restore()
    const reason = sent.error ?? '写回聊天框并发送失败'
    getOverlayManager().flashHint(inplaceFailureLine({ reason, restored }))
    return {
      ok: false,
      draft,
      translated,
      grabMs: grabbed.ms,
      translateMs,
      sendMs: sent.ms,
      restored,
      error: reason
    }
  }
  return { ok: true, draft, translated: delivery.line, grabMs: grabbed.ms, translateMs, sendMs: sent.ms, restored: false }
}

/** 只翻不发：译文进剪贴板，渲染层直接粘贴（Alt+Shift+T 回复框的「翻译」按钮）。 */
export async function translateReplyToClipboard(text: string, tone?: ReplyTone): Promise<ReplyResult> {
  const trimmed = String(text ?? '').trim()
  if (!trimmed) return { ok: false, translated: null, copied: false, error: '内容为空' }
  const settings = loadSettings()
  try {
    const translated = await translateReply(settings.provider, trimmed, tone ?? settings.replyTone)
    clipboard.writeText(translated)
    return { ok: true, translated, copied: true }
  } catch (err) {
    return {
      ok: false,
      translated: null,
      copied: false,
      error: err instanceof Error ? err.message : String(err)
    }
  }
}
