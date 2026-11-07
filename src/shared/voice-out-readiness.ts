/**
 * 「GV 能不能出声」的唯一判断。面板的按钮态、缺项提示、一键动作，
 * 以及运行时的失败短语全从这里取词——四处各写一句，迟早互相矛盾。
 *
 * 断链是一个有序的因果链：引擎包 → 音色包 → 服务 → 参考音频。
 * 两环同时坏时只报最前面那一环，因为后面的修了也没用。
 */
export type VoiceOutBlockReason =
  | 'engine-missing' // GV 引擎包不在（runtime/python.exe 与 api_v2.py 缺一）
  | 'pack-missing' // 没有可用的音色包（未安装 / 无激活包）
  | 'refs-missing' // 包在，但参考音频没选中
  | 'service-down' // 服务未起、也没有外部实例占端口
  | 'service-starting' // 正在拉起，稍后自会 ready

export type VoiceOutAction = 'install-engine' | 'open-packs' | 'start-service'

export interface VoiceOutReadiness {
  ready: boolean
  reason: VoiceOutBlockReason | null
  /** 给用户看的一句话：只说缺哪一环和怎么办，不出现 api_v2 / refs.json 这类内部词。 */
  line: string
  /** 一键动作；就绪或只需等待时为 null。 */
  action: VoiceOutAction | null
}

export interface VoiceOutReadinessInput {
  engineInstalled: boolean
  serverPhase: 'off' | 'starting' | 'ready' | 'external'
  packInstalled: boolean
  refAudio: string
}

/**
 * 每一环的措辞表：`cause` 是「缺什么」（就绪行和运行时失败短语共用它），
 * `advice` 是「怎么办」，两者拼成就绪行。加一环只改这张表。
 */
const BLOCK_COPY: Record<VoiceOutBlockReason, { cause: string; advice: string; action: VoiceOutAction | null }> = {
  'engine-missing': { cause: 'GV 引擎还没装', advice: '去音色包弹窗装引擎包', action: 'install-engine' },
  'pack-missing': { cause: '还没有可用的音色包', advice: '装一个英雄音色包再试', action: 'open-packs' },
  'service-starting': { cause: 'GV 服务正在启动', advice: '约 15–40 秒，就绪后会自动亮起', action: null },
  'service-down': { cause: 'GV 服务没在跑', advice: '点一下启动服务', action: 'start-service' },
  'refs-missing': { cause: '参考音频没选', advice: '去音色包弹窗选一条', action: 'open-packs' }
}

/** 缺的那一环叫什么——就绪行和失败短语都从这里取，措辞不会各说各的。 */
export function voiceOutCause(reason: VoiceOutBlockReason): string {
  return BLOCK_COPY[reason].cause
}

/**
 * 运行时失败短语（合成失败时念给人听的那句）。有原因就点名原因；
 * 没原因（链是齐的却合成失败：显存、坏参考、服务假死）退回一句总括，
 * 不猜也不把「都齐了」说成故障。
 */
export function voiceOutFailPhrase(reason: VoiceOutBlockReason | null): string {
  // 没探到原因就只说不确定性、把人指到就绪行——把四环再念一遍会让「四样都齐了仍然失败」读成故障清单。
  if (reason === null) return 'GV 合成失败（原因没探到，对讲页的就绪行会点名缺哪一环）'
  return `GV 合成失败（${voiceOutCause(reason)}）`
}

/**
 * 优先级即契约：引擎 → 包 → 启动中 → 服务 → 参考。
 * 「启动中」故意压过「服务没跑」——这是等待而不是故障，不该递一个按钮过去。
 */
export function judgeVoiceOutReadiness(input: VoiceOutReadinessInput): VoiceOutReadiness {
  const reason: VoiceOutBlockReason | null = !input.engineInstalled
    ? 'engine-missing'
    : !input.packInstalled
      ? 'pack-missing'
      : input.serverPhase === 'starting'
        ? 'service-starting'
        : input.serverPhase === 'off'
          ? 'service-down'
          : input.refAudio.trim() === ''
            ? 'refs-missing'
            : null
  if (reason === null) {
    return { ready: true, reason: null, line: 'GV 就绪：引擎、音色包、服务、参考音频都在', action: null }
  }
  const copy = BLOCK_COPY[reason]
  return { ready: false, reason, line: `${copy.cause}：${copy.advice}`, action: copy.action }
}

/** 就绪行只在声出引擎是 GV 时出现：Edge/离线用户不该看见一条与自己无关的链。 */
export function voiceOutReadinessVisible(engine: string | null | undefined): boolean {
  return engine === 'sovits'
}

/** 快照去重：相等就视为无变化，广播靠它挡掉 3 秒一次的空刷。 */
export function sameVoiceOutReadiness(a: VoiceOutReadiness | null, b: VoiceOutReadiness | null): boolean {
  if (a === null || b === null) return a === b
  return a.ready === b.ready && a.reason === b.reason && a.action === b.action && a.line === b.line
}
