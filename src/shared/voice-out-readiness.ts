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

/** 每一环的对外说法（文案与动作成对，改一处就够）。 */
const BLOCK_COPY: Record<VoiceOutBlockReason, { line: string; action: VoiceOutAction | null }> = {
  'engine-missing': { line: 'GV 引擎还没装：装上引擎包才能合成语音', action: 'install-engine' },
  'pack-missing': { line: '还没有可用的音色包：装一个英雄音色包再试', action: 'open-packs' },
  'service-starting': { line: 'GV 服务正在启动（约 15–40 秒），就绪后会自动亮起', action: null },
  'service-down': { line: 'GV 服务没在跑：点一下启动服务', action: 'start-service' },
  'refs-missing': { line: '音色包在，但参考音频没选：去音色包弹窗选一条', action: 'open-packs' }
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
  return { ready: false, reason, line: copy.line, action: copy.action }
}

/** 就绪行只在声出引擎是 GV 时出现：Edge/离线用户不该看见一条与自己无关的链。 */
export function voiceOutReadinessVisible(engine: string | null | undefined): boolean {
  return engine === 'sovits'
}

/** 快照去重：相等就不广播，3 秒空刷不惊动面板。 */
export function sameVoiceOutReadiness(
  a: VoiceOutReadiness | null,
  b: VoiceOutReadiness | null
): boolean {
  if (a === null || b === null) return a === b
  return a.ready === b.ready && a.reason === b.reason && a.action === b.action && a.line === b.line
}
