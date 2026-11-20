/**
 * 麦克风健康探针（#96）：不开麦、不读设备，只钉两条验收线背后的判定。
 *
 * 锁三条：
 * - 静音设备在链跑之前就报出来：开麦那一刻（轨道 ended / muted）判定为坏，`shouldRunChain` 恒 false——
 *   也就是说「设备坏了」这件事先于任何识别发生；
 * - 无帧的录音永远进不了 ASR：0 帧既被采集判定拒（too-short），也过不了 `shouldRunChain` 的双保险；
 * - 电平条是纯换算：0 是 0、静音阈值在低位、说话在六成上下、0.1 以上顶满，单调不倒退。
 */
import { judgeCapture } from '@shared/voice-capture-gate'
import { levelPercent, micDead, micDeadNotice, shouldRunChain, type StreamFacts } from '@shared/mic-health'
import { finishProbe, probeCases } from './harness'

const dead = (facts: StreamFacts): boolean => micDead(facts)
const run = (frames: number, sampleRate = 48_000, rms = 0.05): boolean => {
  const verdict = judgeCapture({ frames, sampleRate, rms, peak: rms })
  return shouldRunChain({ ok: verdict.ok, frames })
}

export async function runMicHealthProbe(): Promise<void> {
  const { cases, push } = probeCases()

  // —— 静音设备：开麦那一刻就能判，不用等录完
  push('轨道 ended 就是设备没了（链不跑）', dead({ readyState: 'ended', muted: false }))
  push('轨道被系统静音也算没声音（链不跑）', dead({ readyState: 'live', muted: true }))
  push('活的、没静音的轨道放行', !dead({ readyState: 'live', muted: false }))
  push('未知 readyState 一律当坏（宁可不录也不送静音）', dead({ readyState: 'starting', muted: false }))
  const notice = micDeadNotice('麦克风阵列 (Realtek(R) Audio)')
  push('掉线提示带设备名并说清去哪改', notice.includes('麦克风阵列') && notice.includes('没声音') && notice.includes('设备'))
  push('设备名缺失时提示不出括号空壳', !micDeadNotice('').includes('（）'))

  // —— 无帧录音：永远不会到达 ASR
  const empty = judgeCapture({ frames: 0, sampleRate: 48_000, rms: 0, peak: 0 })
  push('0 帧的录音被采集端判掉（too-short）', empty.ok === false && empty.reason === 'too-short')
  push('0 帧过不了链的门（judged-false）', !shouldRunChain({ ok: empty.ok, frames: 0 }))
  push('就算有人把 ok 写成立，0 帧仍被帧数兜住', !shouldRunChain({ ok: true, frames: 0 }))
  push('真录到话的录音能进链', run(24_000))
  push('300 毫秒以下的录音进不了链', !run(9_600))

  // —— 电平换算
  push('电平：0 是 0、负数和 NaN 也是 0', levelPercent(0) === 0 && levelPercent(-1) === 0 && levelPercent(Number.NaN) === 0)
  push('电平：静音阈值落低位', levelPercent(0.012) > 0 && levelPercent(0.012) < 20)
  push('电平：正常说话在六成上下', levelPercent(0.05) >= 55 && levelPercent(0.05) <= 65)
  push('电平：0.1 以上顶满且不越界', levelPercent(0.1) === 100 && levelPercent(0.4) === 100)
  push('电平单调不倒退', levelPercent(0.02) <= levelPercent(0.04) && levelPercent(0.04) <= levelPercent(0.06))

  finishProbe('MIC_HEALTH_PROBE', cases)
}
