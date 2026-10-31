/**
 * 重复句缓存：段粒度 key（文本/语速/语言/参考音频/转写/服务地址），内存 50 条 LRU。
 * Dota 聊天重复率高（「gg」「打得好」），命中直接回放上次音频——0 毫秒 0 显卡。
 * 切音色、切权重时必须调用 `resetSovitsCache` 清空，防止吃到旧音色的音频
 * （设计记录见 docs/adr/tts-repeat-cache.md）。
 */
const LIMIT = 50
const entries = new Map<string, Buffer>()

export function sovitsCacheKey(parts: {
  text: string
  rate: number
  lang: 'zh' | 'en'
  refAudio: string
  promptText: string
  baseUrl: string
}): string {
  return [parts.text, parts.rate, parts.lang, parts.refAudio, parts.promptText, parts.baseUrl].join('\u0000')
}

export function lookupSovitsCache(key: string): Buffer | null {
  const hit = entries.get(key)
  if (hit === undefined) return null
  // 重插一次把这条挪到「最新」端，维持 LRU 顺序（Map 保持插入序）。
  entries.delete(key)
  entries.set(key, hit)
  console.log('TTS_CACHE_HIT', JSON.stringify({ bytes: hit.length }))
  return hit
}

export function storeSovitsCache(key: string, audio: Buffer): void {
  entries.set(key, audio)
  if (entries.size > LIMIT) {
    // keys().next().value 就是最老的那条。
    const oldest = entries.keys().next().value
    if (oldest !== undefined) entries.delete(oldest)
  }
}

export function resetSovitsCache(): void {
  if (entries.size > 0) console.log('TTS_CACHE_RESET', JSON.stringify({ dropped: entries.size }))
  entries.clear()
}

/** 探针用：当前缓存条数。 */
export function sovitsCacheSize(): number {
  return entries.size
}
