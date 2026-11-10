/**
 * 翻译侧的只读面：数数不动文件。面板确认框与探针共用这一个口径；
 * 会话槽怎么数、记账对从哪来，只在这里落一次。
 */
import type { ProviderConfig, TranslationCacheCounts } from '@shared/ipc'
import { loadSettings } from '../settings'
import { countStateSlots, providerKey, sessionPaths } from './durable-translator'
import { translationCachePairsFor } from './translate-cache'


/**
 * 只数数不动文件：这个 provider 名下的记账对与会话槽。面板确认框的第一步。
 * 参数可显式传入（探针用假 provider），不传就是当前设置里的 provider。
 */
export function inspectTranslationCache(provider: ProviderConfig = loadSettings().provider): TranslationCacheCounts {
  return {
    pairs: translationCachePairsFor(providerKey(provider)),
    conversations: countStateSlots(sessionPaths(provider).state),
    model: provider.model
  }
}
