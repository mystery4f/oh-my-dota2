import { finishProbe, probeCases } from './harness'
import {
  ASR_ROUTE_LONG_ENGINE,
  ASR_ROUTE_SHORT_ENGINE,
  ASR_ROUTE_SHORT_MS,
  routeAsrClip,
  routingLine,
  routingLogRecord
} from '@shared/asr-routing'
import type { AsrRouteDecision, AsrRouteInput } from '@shared/asr-routing'

/**
 * 短句/长句分流（#122）的验收探针。
 *
 * 票面三条验收，逐条对应：
 * - 两种长度各走各的：短（1000ms）→ paraformer 并 switched，长（5000ms）→ qwen3 并 switched；
 * - 规则一关回到单引擎：ruleOn=false → 现役引擎、switched=false、reason='rule-off'；
 * - 每次切换都带原因：routingLine 对五个 reason 各出人话，routingLogRecord 字段齐全。
 * 保护线再钉三条：3000ms 整算短句；现役不在这一对里不插手；目标没装好留在现役并写明 target-missing。
 */
export async function runAsrRoutingProbe(): Promise<void> {
  const { cases, push } = probeCases()

  const d = (input: AsrRouteInput): AsrRouteDecision => routeAsrClip(input)

  // —— 验收一：两种长度各走各的 ——
  push(
    '短句（1000ms，两副都在场）走 paraformer 且 switched',
    (() => {
      const r = d({ durationMs: 1000, activeEngine: 'qwen3', ruleOn: true, shortReady: true, longReady: true })
      return r.engine === ASR_ROUTE_SHORT_ENGINE && r.switched && r.reason === 'short'
    })(),
    '期望 paraformer+switched+short',
  )
  push(
    '长句（5000ms）走 qwen3 且 switched',
    (() => {
      const r = d({ durationMs: 5000, activeEngine: 'paraformer', ruleOn: true, shortReady: true, longReady: true })
      return r.engine === ASR_ROUTE_LONG_ENGINE && r.switched && r.reason === 'long'
    })(),
    '期望 qwen3+switched+long',
  )
  push(
    '3000ms 整算短句（边界贴合常量）',
    (() => {
      const r = d({ durationMs: ASR_ROUTE_SHORT_MS, activeEngine: 'paraformer', ruleOn: true, shortReady: true, longReady: true })
      return r.engine === ASR_ROUTE_SHORT_ENGINE && !r.switched && r.reason === 'short'
    })(),
    '期望 paraformer+不换+short',
  )

  // —— 验收二：规则一关回到单引擎 ——
  push(
    '规则关着：用现役引擎、不换、reason=rule-off',
    (() => {
      const r = d({ durationMs: 1000, activeEngine: 'qwen3', ruleOn: false, shortReady: true, longReady: true })
      return r.engine === 'qwen3' && !r.switched && r.reason === 'rule-off' && r.durationMs === 1000
    })(),
    '期望 qwen3+不换+rule-off',
  )

  // —— 验收三 + 保护线 ——
  push(
    '现役不在短/长这一对里：不插手（reason=not-a-pair）',
    (() => {
      const r = d({ durationMs: 1000, activeEngine: 'other-engine' as never, ruleOn: true, shortReady: true, longReady: true })
      return (r.engine as string) === 'other-engine' && !r.switched && r.reason === 'not-a-pair'
    })(),
    '期望留在现役+not-a-pair',
  )
  push(
    '短句目标没装好：留在现役并写明 target-missing',
    (() => {
      const r = d({ durationMs: 1000, activeEngine: 'qwen3', ruleOn: true, shortReady: false, longReady: true })
      return r.engine === 'qwen3' && !r.switched && r.reason === 'target-missing'
    })(),
    '期望 qwen3+不换+target-missing',
  )
  push(
    '长句目标没装好：同样留在现役',
    (() => {
      const r = d({ durationMs: 5000, activeEngine: 'qwen3', ruleOn: true, shortReady: true, longReady: false })
      return r.engine === 'qwen3' && !r.switched && r.reason === 'target-missing'
    })(),
    '期望 qwen3+不换+target-missing',
  )

  push(
    '每个 reason 都有一句人话（routingLine）',
    (() => {
      const words: Array<[string, string]> = [
        ['rule-off', '分流关着'],
        ['not-a-pair', '不插手'],
        ['target-missing', '没装好'],
        ['short', '短句走快引擎'],
        ['long', '长句走准引擎'],
      ]
      for (const [reason, word] of words) {
        const line = routingLine({ ...d({ durationMs: 2000, activeEngine: 'qwen3', ruleOn: true, shortReady: true, longReady: true }), reason } as never, 'qwen3')
        if (!line.includes(word)) return false
      }
      return true
    })(),
    '五个 reason 各含关键字',
  )
  push(
    'routingLogRecord 字段齐全（切换日志契约）',
    (() => {
      const decision = d({ durationMs: 1000, activeEngine: 'qwen3', ruleOn: true, shortReady: true, longReady: true })
      const rec = routingLogRecord(decision, 'qwen3')
      return (
        rec.from === 'qwen3' &&
        rec.to === ASR_ROUTE_SHORT_ENGINE &&
        rec.reason === 'short' &&
        rec.switched &&
        typeof rec.note === 'string' &&
        rec.note.includes('paraformer') &&
        rec.durationMs === 1000
      )
    })(),
    'from/to/reason/switched/note/durationMs',
  )
  push(
    '现役恰是目标档时不换，reason 是 short/long 而非 switch（避免日志刷屏）',
    (() => {
      const r = d({ durationMs: 1000, activeEngine: 'paraformer', ruleOn: true, shortReady: true, longReady: true })
      return r.engine === 'paraformer' && !r.switched && r.reason === 'short' && routingLine(r, 'paraformer').includes('就是这一档')
    })(),
    '期望 paraformer+不换+short+「就是这一档」',
  )

  finishProbe('ASR_ROUTING_PROBE', cases)
}