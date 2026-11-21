/**
 * --asr-routing-wire-probe：分流开关真的被读进来、真的换了引擎（#154）。
 *
 * 两层：
 * 一层是纯的（任何机器都跑）：`routingFor` 把开关与 ready 情况拼成 `routeAsrClip` 的入参。
 * 一层是真的（只在模型齐全且用户已开分流时跑）：调真的 `transcribeAsr()` 两段音频，
 * 从它打的 `ASR_ROUTE` 日志确认出现过两个不同 `engine`。
 *
 * 第二层缺条件时 **SKIP 并点名缺什么**——静默通过等于什么都没说（pm 的口径）。
 */
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ASR_ROUTE_LONG_ENGINE,
  ASR_ROUTE_SHORT_ENGINE,
  routeAsrClip,
  routingFor,
  routingLogRecord
} from '@shared/asr-routing'
import { WAV_SAMPLE_RATE, encodeWav16k } from '@shared/wav'
import { loadSettings } from '../services/settings'
import { readyEngineIds, transcribeAsr } from '../services/voice/asr-model'
import { finishProbe, probeCases } from './harness'

/** 生成一段静音 wav 到临时目录（不写用户数据）。 */
function silenceWav(ms: number, dir: string): string {
  const samples = Math.round((WAV_SAMPLE_RATE * ms) / 1000)
  const path = join(dir, `silence-${ms}.wav`)
  writeFileSync(path, Buffer.from(encodeWav16k([new Float32Array(samples)], WAV_SAMPLE_RATE), 'base64'))
  return path
}

export function runAsrRoutingWireProbe(): void {
  const { cases, push } = probeCases()
  const active = ASR_ROUTE_LONG_ENGINE
  const both = { activeEngine: active, ready: [ASR_ROUTE_SHORT_ENGINE, ASR_ROUTE_LONG_ENGINE] }

  // 第一层：settings → 入参（任何机器都验得到）
  const off = routingFor(false, both, 9000)
  push('开关 off 时入参 ruleOn 是 false', off.ruleOn === false)
  push('开关 off 时哪一档都不换（长句留在现役）', routeAsrClip(off).reason === 'rule-off')

  const on = routingFor(true, both, 1200)
  push('开关 on 时入参 ruleOn 是 true', on.ruleOn === true)
  const short = routeAsrClip(on)
  push('短句切到快引擎 paraformer', short.engine === ASR_ROUTE_SHORT_ENGINE && short.switched === true, routingLogRecord(short, active).note)
  const longDecision = routeAsrClip(routingFor(true, both, 9000))
  push('长句本来就在长引擎，不换也算对', longDecision.engine === ASR_ROUTE_LONG_ENGINE && longDecision.switched === false, longDecision.reason)

  const onlyLong = routingFor(true, { activeEngine: active, ready: [ASR_ROUTE_LONG_ENGINE] }, 1200)
  push('短句那副没 ready 时留在现役（不硬换）', routeAsrClip(onlyLong).reason === 'target-missing')
  push('ready 名单里没列出的引擎不会被选中', routingFor(true, { activeEngine: active, ready: [] }).shortReady === false)
  const outsider = routingFor(true, { activeEngine: ASR_ROUTE_SHORT_ENGINE, ready: both.ready }, 1200)
  push('现役已经就是这一档时不重复切（同引擎不算换）', routeAsrClip(outsider).switched === false)

  // 第二层：真跑（缺条件就 SKIP，并点名缺什么）
  const settings = loadSettings()
  const ready = readyEngineIds()
  const missing = [ASR_ROUTE_SHORT_ENGINE, ASR_ROUTE_LONG_ENGINE].filter((engine) => !ready.includes(engine))

  if (missing.length > 0) {
    push(`SKIP 真换验证：缺 ${missing.join(' / ')} 的 ready 模型`, true, 'skipped')
    finishProbe('ASR_ROUTING_WIRE_PROBE', cases, { ready, missing, configured: settings.asrRouteShortLong === true })
    return
  }
  if (settings.asrRouteShortLong !== true) {
    push('SKIP 真换验证：分流开关现在关着（打开后重跑才有意义）', true, 'skipped')
    finishProbe('ASR_ROUTING_WIRE_PROBE', cases, { ready, missing, configured: false })
    return
  }

  const dir = mkdtempSync(join(tmpdir(), 'omd2-route-'))
  const shortWav = silenceWav(1200, dir)
  const longWav = silenceWav(6500, dir)
  const engines: string[] = []
  const original = console.log
  console.log = (...args: unknown[]): void => {
    const line = String(args[0] ?? '')
    if (line.startsWith('ASR_ROUTE ')) {
      try {
        engines.push((JSON.parse(line.slice('ASR_ROUTE '.length)) as { to: string }).to)
      } catch {
        // 日志坏了不在这里判——下面「两个不同 engine」自然失败。
      }
    }
    original(...args)
  }
  void (async (): Promise<void> => {
    try {
      await transcribeAsr(shortWav)
      await transcribeAsr(longWav)
    } finally {
      console.log = original
    }
    push('真跑两段后 ASR_ROUTE 里出现两个不同 engine', new Set(engines).size === 2, engines.join(' → '))
    push('第一段是短句那副快引擎', engines[0] === ASR_ROUTE_SHORT_ENGINE, engines.join(' → '))
    finishProbe('ASR_ROUTING_WIRE_PROBE', cases, { engines, configured: true })
  })()
}
