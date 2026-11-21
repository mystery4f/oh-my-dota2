/**
 * 同声模式探针（#128）：不开麦、不出声、不碰设备，只钉四条验收线背后的判定。
 *
 * 锁四件：
 * - 一句话的进/退：识别为空、译文为空都不进同声腿（空话灌进游戏话筒只会让队友听见静音）；
 * - 设备优先级：显式指定的「游戏话筒」优先，没有才跟输出设备走——设错了就是队友听不见；
 * - 不按说话键、本机不回放：游戏里电缆那一路常开，按 F5 只把开麦切成和音频不同步；
 *   英文已经进了话筒，中文再在本机念一遍两种语言会同时说；
 * - 关掉模式时老链条一个字节都不变：链上那条 meta 不带 sink、不带 interpret 阶段。
 */
import { INTERPRET_STAGE, interpretDeviceLine, interpretLegOf, interpretPlanOf } from '@shared/interpret'
import type { VoiceChainMeta } from '../services/voice/chain-timing'
import { finishProbe, probeCases } from './harness'

/** 关掉模式时 `reply-service` 传的 meta：与 #128 之前完全同形（没有 sink、阶段是 null）。 */
const plainMeta = (): VoiceChainMeta => ({
  spoken: true,
  stage: null,
  engine: 'sovits',
  chars: 12,
  segments: 1,
  mic: '麦克风阵列|a1b2c3d4'
})

export async function runInterpretLegProbe(): Promise<void> {
  const { cases, push: check } = probeCases()

  // —— 进/退：空的一律不进同声腿
  check('识别为空 -> 不进同声腿', !interpretPlanOf({ recognized: '   ', translated: 'hello' }).speak)
  check(
    '识别为空的原因记的是 empty-recognition',
    interpretPlanOf({ recognized: '', translated: 'hello' }).reason === 'empty-recognition'
  )
  check('译文为空 -> 不进同声腿', !interpretPlanOf({ recognized: '打野', translated: '  ' }).speak)
  check(
    '译文为空的原因记的是 empty-translation',
    interpretPlanOf({ recognized: '打野', translated: '' }).reason === 'empty-translation'
  )
  check('一句正常的话进同声腿', interpretPlanOf({ recognized: '打野', translated: 'jungle' }).speak)
  check('进了就没有 reason', interpretPlanOf({ recognized: '打野', translated: 'jungle' }).reason === null)

  // —— 设备：显式指定优先，否则跟输出设备
  const explicit = interpretLegOf({ interpretInDevice: 'cable-in', ttsOutputDevice: 'speaker-1' })
  check('显式指定的游戏话筒优先', explicit.device === 'cable-in')
  const fallback = interpretLegOf({ interpretInDevice: '', ttsOutputDevice: 'cable-0' })
  check('没指定时跟输出设备走', fallback.device === 'cable-0')
  check(
    '只填空格也算没指定（跟输出设备）',
    interpretLegOf({ interpretInDevice: '   ', ttsOutputDevice: 'cable-0' }).device === 'cable-0'
  )
  check('两处都没选就是空设备（交给系统默认，不编一个）', interpretLegOf({ interpretInDevice: '', ttsOutputDevice: '' }).device === '')
  check('同声腿永远不按说话键', explicit.keyless === true)
  check('同声腿本机不回放译文（回放的是原音）', explicit.monitorLocal === false)

  // —— 阶段名独立：慢在哪一段才量得出来
  check('同声腿有自己的阶段名', INTERPRET_STAGE === 'interpret')

  // —— 面板那行话：选好了念设备名，没选就说清下一步
  check('选了设备 -> 念设备名', interpretDeviceLine('CABLE Input (VB-Audio Virtual Cable)').includes('CABLE Input'))
  check(
    '没选设备 -> 说清先改游戏麦克风',
    interpretDeviceLine('').includes('Dota 2') && interpretDeviceLine('').includes('麦克风')
  )

  // —— 关掉模式：老链条同形
  const meta = plainMeta()
  check('模式关着时链上不带 sink', meta.sink === undefined)
  check('模式关着时阶段是 null（不是 interpret）', meta.stage !== INTERPRET_STAGE)

  finishProbe('INTERPRET_LEG_PROBE', cases)
}
