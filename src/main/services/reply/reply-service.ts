import { clipboard } from 'electron'
import {
  type InPlaceResult,
  type ReplyResult,
  type ReplySendResult,
  type ReplyTone,
  type VoiceReplyResult
} from '@shared/ipc'
import { decideVoiceOutReply } from '@shared/voice-out'
import { loadSettings } from '../settings'
import { translateReply } from '../session/durable-translator'
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
 * 读取游戏聊天框里已经打好但未发送的中文，翻译成英文后粘贴回同一个输入框并回车发送。
 * 全程不切换前台窗口，也不经过控制台。
 */
export async function translateInPlace(): Promise<InPlaceResult> {
  const settings = loadSettings()
  const sender = getInPlaceSender()
  const grabbed = await sender.grab()
  if (!grabbed.ok || !grabbed.text) {
    return {
      ok: false,
      draft: null,
      translated: null,
      grabMs: grabbed.ms,
      error: grabbed.error ?? '没有读到聊天框内容'
    }
  }
  const draft = grabbed.text
  const translateStartedAt = Date.now()
  let translated: string | null = null
  try {
    translated = await translateReply(settings.provider, draft, settings.replyTone)
  } catch (err) {
    return {
      ok: false,
      draft,
      translated: null,
      grabMs: grabbed.ms,
      translateMs: Date.now() - translateStartedAt,
      error: err instanceof Error ? err.message : String(err)
    }
  }
  const translateMs = Date.now() - translateStartedAt
  if (!translated) {
    return { ok: false, draft, translated: null, grabMs: grabbed.ms, translateMs, error: '翻译结果为空' }
  }
  const line = normalizeChatLine(translated)
  if (!line) {
    return { ok: false, draft, translated, grabMs: grabbed.ms, translateMs, error: '译文没有可发送的英文字符' }
  }
  const sent = await sender.replace(line)
  if (!sent.ok) {
    return {
      ok: false,
      draft,
      translated,
      grabMs: grabbed.ms,
      translateMs,
      sendMs: sent.ms,
      error: sent.error ?? '写回聊天框并发送失败'
    }
  }
  return { ok: true, draft, translated: line, grabMs: grabbed.ms, translateMs, sendMs: sent.ms }
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
