/**
 * 短句/长句分流（#122）：一条念短的、一条念准的，规则可关。
 *
 * 事实基础（来自引擎表 src/shared/asr/engines.ts）：paraformer 是 int8 小模型、不带标点，
 * 转写一段两三秒的话比 qwen3 快；qwen3 0.6B 带标点、听得准，但慢。
 * 所以「短」给 paraformer、「长」给 qwen3 —— 时长是录完就已知的事实，不猜。
 *
 * 三条硬约束，都在 routeAsrClip 里按顺序落地：
 * - 规则关着：一律用现役引擎，连理由都不换（票面第二条验收）。
 * - 现役引擎不在这一对里（用户钉了别的、或钉了备份）：不插手，原生行为不变。
 * - 目标引擎没装好：留在现役引擎，reason 写明 target-missing —— 分流只能在
 *   两副模型都在场时发生。worker 现在留两份图（#142，`MAX_RECOGNIZERS = 2`），
 *   但第一句换引擎仍要付一次加载，而错的目标只会让人听见「变慢了」而不是「变准了」。
 */
import type { AsrEngineId } from './asr/engines'

/** 分流阈值：念完 3 秒以内算短句。取自对讲实况——一句「他中路不见了」约 1.5–2.5 秒。 */
export const ASR_ROUTE_SHORT_MS = 3000

/** 短句走快的、长句走准的。写成常量而不是设置项：换引擎表时才该动这里。 */
export const ASR_ROUTE_SHORT_ENGINE: AsrEngineId = 'paraformer'
export const ASR_ROUTE_LONG_ENGINE: AsrEngineId = 'qwen3'

export type AsrRouteReason = 'rule-off' | 'not-a-pair' | 'target-missing' | 'short' | 'long'

export interface AsrRouteInput {
  /** 这段录音多长（毫秒）。录完就知道，不看内容。 */
  durationMs: number
  /** 现役引擎（设置 + 可用性决定的那一份）。 */
  activeEngine: AsrEngineId
  /** 规则开关。 */
  ruleOn: boolean
  /** 目标引擎的模型是否装好可用。 */
  shortReady: boolean
  longReady: boolean
}

export interface AsrRouteDecision {
  engine: AsrEngineId
  /** true = 这一句换了引擎（要打日志）。 */
  switched: boolean
  reason: AsrRouteReason
  /** 判定时的时长，供日志与面板对账。 */
  durationMs: number
}

/** 这一句该用哪个引擎。纯函数：同一个输入永远同一个答案，探针据此钉票面。 */
/**
 * 从「设置里的开关 + 现场有哪些 ready 模型」拼出 `routeAsrClip` 的入参（#154）。
 *
 * 拆出来的理由：`transcribeAsr()` 里那三行（读开关、扫 ready、拼对象）没法在探针里验——
 * 纯缝 `routeAsrClip` 早已覆盖，缺的正是这一段「settings 真的被读进来了」。
 */
export interface AsrRouteModels {
  activeEngine: AsrEngineId
  ready: readonly AsrEngineId[]
}

export function routingFor(
  ruleOn: boolean,
  models: AsrRouteModels,
  durationMs = 0
): AsrRouteInput {
  return {
    durationMs,
    activeEngine: models.activeEngine,
    ruleOn,
    shortReady: models.ready.includes(ASR_ROUTE_SHORT_ENGINE),
    longReady: models.ready.includes(ASR_ROUTE_LONG_ENGINE)
  }
}

export function routeAsrClip(input: AsrRouteInput): AsrRouteDecision {
  const keep = (reason: AsrRouteReason): AsrRouteDecision => ({
    engine: input.activeEngine,
    switched: false,
    reason,
    durationMs: input.durationMs
  })
  if (!input.ruleOn) return keep('rule-off')
  const isPair = input.activeEngine === ASR_ROUTE_SHORT_ENGINE || input.activeEngine === ASR_ROUTE_LONG_ENGINE
  if (!isPair) return keep('not-a-pair')
  const wanted = input.durationMs <= ASR_ROUTE_SHORT_MS ? ASR_ROUTE_SHORT_ENGINE : ASR_ROUTE_LONG_ENGINE
  const ready = wanted === ASR_ROUTE_SHORT_ENGINE ? input.shortReady : input.longReady
  const shortLong: AsrRouteReason = wanted === ASR_ROUTE_SHORT_ENGINE ? 'short' : 'long'
  if (!ready) return keep('target-missing')
  return { engine: wanted, switched: wanted !== input.activeEngine, reason: shortLong, durationMs: input.durationMs }
}

/** 日志/面板的一句话：换没换、为什么。切换日志只认这一处文案。 */
export function routingLine(decision: AsrRouteDecision, activeEngine: AsrEngineId): string {
  const seconds = Math.round(decision.durationMs / 100) / 10
  if (decision.reason === 'rule-off') return `分流关着 · ${seconds}s 用现役 ${activeEngine}`
  if (decision.reason === 'not-a-pair') return `现役 ${activeEngine} 不在短/长这一对里，不插手 · ${seconds}s`
  if (decision.reason === 'target-missing')
    return `${seconds}s 本该走 ${decision.durationMs <= ASR_ROUTE_SHORT_MS ? ASR_ROUTE_SHORT_ENGINE : ASR_ROUTE_LONG_ENGINE}，没装好 · 留 ${activeEngine}`
  if (decision.switched) return `${seconds}s · ${activeEngine} → ${decision.engine}（${decision.reason === 'short' ? '短句走快引擎' : '长句走准引擎'}）`
  return `${seconds}s · 现役 ${activeEngine} 就是这一档`
}

/** 日志记录：主进程原样 JSON 打出去，字段本身是被探针钉住的那一份契约。 */
export interface AsrRouteLog {
  from: AsrEngineId
  to: AsrEngineId
  durationMs: number
  reason: AsrRouteReason
  switched: boolean
  /** 人话版本（routingLine），面板与日志共用同一句。 */
  note: string
}

export function routingLogRecord(decision: AsrRouteDecision, activeEngine: AsrEngineId): AsrRouteLog {
  return {
    from: activeEngine,
    to: decision.engine,
    durationMs: decision.durationMs,
    reason: decision.reason,
    switched: decision.switched,
    note: routingLine(decision, activeEngine)
  }
}

/** 面板开关旁边的说明：一句话讲清代价，别让用户以为白拿。 */
export function routingHint(activeEngine: AsrEngineId, shortReady: boolean, longReady: boolean): string {
  const missing: string[] = []
  if (!shortReady) missing.push(`${ASR_ROUTE_SHORT_ENGINE} 没装`)
  if (!longReady) missing.push(`${ASR_ROUTE_LONG_ENGINE} 没装`)
  if (missing.length > 0) return `分流要两副模型都在场（${missing.join('、')}），缺的那档会留在现役 ${activeEngine}`
  return `短句（≤${ASR_ROUTE_SHORT_MS / 1000} 秒）走 ${ASR_ROUTE_SHORT_ENGINE}，长句走 ${ASR_ROUTE_LONG_ENGINE}；两台各自只加载一次（两份模型常驻内存），之后换引擎只是换个指针`
}
