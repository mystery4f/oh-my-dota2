/**
 * #114：把采样窗口与设置里的供应商名单拼成一块板。
 *
 * 名单只从设置里取：`provider.id` 加上 `providerKeys` 里已有的那几家。名单之外的供应商
 * 只有真的打过交道（有样本）才会出现在板上——那是事实，删掉会让人以为从没发生。
 */
import { latencyBoardOf, type LatencyBoardRow } from '@shared/latency-board'
import { latencySamplesForBoard } from './translator-latency'
import { loadSettings } from '../settings'

/** 设置里现在有哪些供应商（一个都没配也要留 id，面板才知道该显示谁）。 */
export function knownProviderIds(): string[] {
  const settings = loadSettings()
  const ids = new Set<string>()
  if (settings.provider?.id) ids.add(settings.provider.id)
  for (const key of Object.keys(settings.providerKeys ?? {})) ids.add(key)
  return [...ids]
}

/** 延迟板：只由真实样本算出。 */
export function latencyBoardView(): LatencyBoardRow[] {
  return latencyBoardOf(latencySamplesForBoard(), knownProviderIds())
}