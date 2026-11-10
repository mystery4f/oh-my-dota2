import type { VoiceOutReadiness } from '@shared/voice-out-readiness'
import { judgeVoiceOutReadiness, sameVoiceOutReadiness } from '@shared/voice-out-readiness'
import { loadSettings } from '../settings'
import { onVoiceOutMutation } from './mutations'
import { sovitsStatusSnapshot } from './sovits-server'
import { sovitsVoicePacks } from './sovits-voicepack'

/**
 * 就绪快照的唯一持有者。判断本身在 shared 的纯函数里，这里只负责
 * 「把四环的现状凑成输入 → 判一次 → 变了才喊人」，避免渲染层为它开定时器。
 *
 * 3 秒一次的 tick 在 index.ts 里跑（外部起的服务、被外部杀掉的进程只能靠探测发现）；
 * 设置保存与语音域里的装包/装引擎/选音色/起服务在各自的变更点广播，这里订一次就够。
 */
let cached: VoiceOutReadiness | null = null
let inflight: Promise<VoiceOutReadiness | null> | null = null
const listeners = new Set<(snapshot: VoiceOutReadiness | null) => void>()

function emit(snapshot: VoiceOutReadiness | null): void {
  for (const listener of listeners) listener(snapshot)
}

// 语音域的变更点在这里汇总成一次重算：handler 表不用逐个记得包刷新，
// 以后新加的变更点也自动生效（漏包一处就只剩 3 秒 tick 兜底，那正是事故的温床）。
onVoiceOutMutation(() => {
  void refreshVoiceOutReadiness()
})

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
  // 声出不走 GV 的用户不该为这条链付任何成本：探测端口、读 refs.json、
  // 必要时还会拉远端音色包清单——3 秒一次的空刷在 Edge/离线用户那里纯属浪费。
  if (loadSettings().ttsOutEngine !== 'sovits') return cached
  // 一轮没跑完就不再叠一轮（远端清单慢时 3 秒 tick 会堆请求）。
  if (inflight) return inflight
  inflight = compute()
  try {
    return await inflight
  } finally {
    inflight = null
  }
}

async function compute(): Promise<VoiceOutReadiness | null> {
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
