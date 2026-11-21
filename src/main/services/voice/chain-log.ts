/**
 * `logs/voice-chain.jsonl` 的写入面（#164）。
 *
 * 一局收工后要看的是**一条时间线**：哪句被念、哪句被跳过、哪段录音被丢。
 * 所以朗读腿、半双工守卫、链计时都写同一个文件、用同一个上限写入器；
 * 这里只解决「路径 + 上限 + 写失败不抛」这三件每次都要手抄的细节。
 */
import { appendCappedJsonl } from '../logs/jsonl'
import { join } from 'node:path'
import { logsDir } from '../logs/base-dir'

/** 与控制台/设计口径一致的上限；超过就按行截断，不另开文件。 */
export const VOICE_CHAIN_MAX_BYTES = 256 * 1024

export function voiceChainPath(): string {
  return join(logsDir(), 'voice-chain.jsonl')
}

/**
 * 追加一行。写日志失败绝不能把语音腿弄死——「念不出来就跳过」是这条链的规矩，
 * 记账同理：记不上就只少一条证据。
 */
export function appendVoiceChainLine(record: Record<string, unknown> | object): void {
  try {
    appendCappedJsonl(voiceChainPath(), { ...record }, VOICE_CHAIN_MAX_BYTES)
  } catch {
    // 记账失败不影响识别/朗读链路
  }
}