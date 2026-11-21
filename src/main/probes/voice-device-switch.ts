/**
 * #91 声出设备热切换的探针。
 *
 * 票面验收：`device switch mid-queue does not truncate the playing segment; a failing device keeps the
 * previous one and reports it`。前半句靠纯规则钉住（正在播时不许换），后半句靠一个假播放器跑一遍
 * 三段队列：第一段用 A、中途把设置改成 B（这一段仍在播）、第二段前 A 坏了回落成 C、第三段应请求 C。
 */
import { planDeviceSwitch, settleDeviceAfterPlay } from '@shared/voice-device-switch'
import { finishProbe, probeCases } from './harness'

interface FakeSegment {
  bytes: Buffer
  requested: string
}

/**
 * 一个最小的假播放器：只在段与段之间读设置，绝不回头改已播段。
 * 返回每个段实际请求的设备，供断言「切设备没有截断前一段」。
 */
function runQueue(options: {
  segments: Buffer[]
  active: string
  desiredAt: (index: number) => string
  fallbackAt?: (index: number) => { sinkId: string; sinkLabel: string } | null
}): { played: FakeSegment[]; active: string; notices: string[] } {
  const played: FakeSegment[] = []
  const notices: string[] = []
  let active = options.active
  let bad = ''
  for (let index = 0; index < options.segments.length; index++) {
    const plan = planDeviceSwitch({ active, desired: options.desiredAt(index), bad })
    if (plan.switched) bad = ''
    if (plan.switched) active = plan.device
    if (plan.line !== null) notices.push(plan.line)
    const fallback = options.fallbackAt?.(index) ?? null
    played.push({ bytes: options.segments[index], requested: active })
    if (fallback !== null) {
      const settled = settleDeviceAfterPlay({
        requested: active,
        fallback: true,
        sinkId: fallback.sinkId,
        sinkLabel: fallback.sinkLabel,
        hint: null
      })
      if (settled.fellBack) bad = active
      active = settled.active
      if (settled.line !== null) notices.push(settled.line)
    }
  }
  return { played, active, notices }
}

export async function runVoiceDeviceSwitchProbe(): Promise<void> {
  const { cases, push } = probeCases()

  // —— 纯规则：什么时候能换 ——
  const same = planDeviceSwitch({ active: 'A', desired: 'A' })
  push('设备没变：不换、不说话', same.switched === false && same.deferred === false && same.line === null, JSON.stringify(same))

  const between = planDeviceSwitch({ active: 'A', desired: 'B' })
  push(
    '段与段之间换设备：生效并留一句',
    between.switched && between.device === 'B' && between.line !== null && between.line.includes('下一段'),
    String(between.line)
  )

  const playing = planDeviceSwitch({ active: 'A', desired: 'B', playing: true })
  push(
    '正在播时要求换：推迟到下一段，当前这段不被打断',
    playing.deferred && playing.device === 'A' && playing.switched === false,
    JSON.stringify(playing)
  )

  const playingSame = planDeviceSwitch({ active: 'A', desired: 'A', playing: true })
  push(
    '正在播且设备没变：既不推迟也不换',
    playingSame.deferred === false && playingSame.switched === false,
    JSON.stringify(playingSame)
  )

  const avoidBad = planDeviceSwitch({ active: 'C', desired: 'A', bad: 'A' })
  push(
    '刚坏的那台还被设置指着：不每段重试，继续用工作的那台',
    avoidBad.switched === false && avoidBad.device === 'C' && avoidBad.line !== null,
    String(avoidBad.line)
  )

  const toDefault = planDeviceSwitch({ active: 'A', desired: '' })
  push('切回系统默认：说清是回到了默认设备', toDefault.switched && toDefault.device === '' && toDefault.line === '声出回到系统默认设备', String(toDefault.line))

  // —— 纯规则：回落怎么记账 ——
  const fell = settleDeviceAfterPlay({ requested: 'B', fallback: true, sinkId: 'C', sinkLabel: '音箱 (Realtek)', hint: null })
  push(
    '回落：把真正工作的那台记成新设备',
    fell.fellBack && fell.active === 'C' && fell.line !== null && fell.line.includes('改播到'),
    String(fell.line)
  )
  push(
    '回落：渲染层给了原因就用它自己的话',
    settleDeviceAfterPlay({ requested: 'B', fallback: true, sinkId: 'C', sinkLabel: 'x', hint: '这台设备已经拔出' }).line ===
      '这台设备已经拔出'
  )
  const noFallback = settleDeviceAfterPlay({ requested: 'B', fallback: false, sinkId: 'B', sinkLabel: 'y', hint: null })
  push('没回落：设备不变、不说话', noFallback.fellBack === false && noFallback.active === 'B' && noFallback.line === null)
  const blankSink = settleDeviceAfterPlay({ requested: 'B', fallback: true, sinkId: '', sinkLabel: '', hint: null })
  push(
    '回落但没报出具体设备：不改 active、也不编一句话',
    blankSink.fellBack === false && blankSink.active === 'B' && blankSink.line === null,
    JSON.stringify(blankSink)
  )
  push(
    '回落到默认设备：那句话写「系统默认设备」而不是空设备 id',
    (settleDeviceAfterPlay({ requested: 'B', fallback: true, sinkId: 'default', sinkLabel: '', hint: null }).line ?? '').includes(
      '系统默认设备'
    )
  )

  // —— 队列：切设备不截断正在播的那一段 ——
  const seg1 = Buffer.from('first-segment-audio')
  const seg2 = Buffer.from('second-segment-audio')
  const seg3 = Buffer.from('third-segment-audio')
  const queue = runQueue({
    segments: [seg1, seg2, seg3],
    active: 'A',
    // 第一段播到一半时设置被改成 B：它属于「正在播」，只能影响下一段。
    desiredAt: (index) => (index === 0 ? 'A' : 'B')
  })
  push(
    '队列：切设备发生在段边界，第一段仍用旧设备',
    queue.played[0].requested === 'A' && queue.played[1].requested === 'B',
    queue.played.map((item) => item.requested).join(',')
  )
  push(
    '队列：已播的音频字节原样不变（没有被截断/重编码）',
    queue.played[0].bytes.equals(seg1) && queue.played[0].bytes.length === seg1.length,
    `${queue.played[0].bytes.length}B`
  )
  push('队列：换设备只提醒一次，不每段重复', queue.notices.length === 1, queue.notices.join(' / '))

  const failing = runQueue({
    segments: [seg1, seg2, seg3],
    active: 'A',
    desiredAt: () => 'A',
    // 第二段请求的 A 坏了，渲染层回落到 C。
    fallbackAt: (index) => (index === 1 ? { sinkId: 'C', sinkLabel: 'CABLE Input' } : null)
  })
  push(
    '队列：设备坏了之后，下一段直接请求那台真正工作的设备',
    failing.played[2].requested === 'C' && failing.active === 'C',
    failing.played.map((item) => item.requested).join(',')
  )
  push(
    '队列：回落留了一句，而不是静默换设备',
    failing.notices.some((line) => line.includes('改播到') && line.includes('CABLE Input')),
    failing.notices.join(' / ')
  )

  finishProbe('VOICE_DEVICE_SWITCH_PROBE', cases)
}