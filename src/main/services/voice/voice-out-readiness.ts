import type { VoiceOutReadiness } from '@shared/voice-out-readiness'
import { judgeVoiceOutReadiness, sameVoiceOutReadiness } from '@shared/voice-out-readiness'
import { loadSettings } from '../settings'
import { sovitsStatusSnapshot } from './sovits-server'
import { sovitsVoicePacks } from './sovits-voicepack'

/**
 * 就绪快照的唯一持有者。判断本身在 shared 的纯函数里，这里只负责
 * 「把四环的现状凑成输入 → 判一次 → 变了才喊人」，避免渲染层为它开定时器。
 *
 * 3 秒一次的 tick 在 index.ts 里跑（外部起的服务、被外部杀掉的进程只能靠探测发现）；
 * 设置保存、装包、装引擎、选择音色这些明确动作则当场刷一次，让面板立刻翻牌。
 */
let cached: VoiceOutReadiness | null = null
const listeners = new Set<(snapshot: VoiceOutReadiness | null) => void>()

function emit(snapshot: VoiceOutReadiness | null): void {
  for (const listener of listeners) listener(snapshot)
}

/** 订阅变更；返回退订。 */
export function onVoiceOutReadiness(listener: (snapshot: VoiceOutReadiness | null) => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

export function currentVoiceOutReadiness(): VoiceOutReadiness | null {
  return cached
}

/**
 * 重算一次。相等就不广播——否则 3 秒一次的空刷会不停唤醒面板。
 * 拿不到 GV 状态（例如早期启动、服务还没初始化）时保持上一次的值。
 */
export async function refreshVoiceOutReadiness(): Promise<VoiceOutReadiness | null> {
  let next: VoiceOutReadiness
  try {
    const [status, packs] = await Promise.all([sovitsStatusSnapshot(), sovitsVoicePacks()])
    const settings = loadSettings()
    next = judgeVoiceOutReadiness({
      engineInstalled: status.installed,
      serverPhase: status.server.phase,
      packInstalled: packs.some((pack) => pack.active && pack.installed),
      refAudio: settings.ttsSovitsRefAudio
    })
  } catch {
    // 探测失败不该让就绪行变成假绿灯：保留上一次的判断，等下一轮 tick。
    return cached
  }
  if (!sameVoiceOutReadiness(cached, next)) {
    cached = next
    emit(cached)
  }
  return cached
}
