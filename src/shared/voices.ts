/**
 * 音色域：离线音色清单与声出/说话方式的枚举。
 * 从 ipc.ts 迁出（架构扫描 C2）：换音色清单不该动契约文件。
 */

export type OfflineVoiceId = 'baker' | 'xiao_ya' | 'eula'
export type VoiceOutEngine = 'edge' | 'offline' | 'sovits'
/** 说话方式：hold = 按住整段（游戏里选「按住说话」）；toggle = 敲一下开麦、播完再敲一下关麦（游戏里选「切换」）。 */
export type SpeakMode = 'hold' | 'toggle'

export interface OfflineVoice {
  id: OfflineVoiceId
  label: string
  note: string
  speed: number
  pitch: number
  /** 多说话人模型固定用这一个嗓子；单说话人模型为 0。 */
  sid: number
}

/**
 * 本地音色留下这三个（用户钦定后又裁掉 melo，2026-10-25）：
 * - baker：Matcha icefall，22.05 kHz，最快（200 ms 级），声音闷一点但最跟得上节奏。
 * - xiao_ya：piper 小雅，22.05 kHz，包最小（60 MB），音色偏温柔。
 * - eula：hf 角色微调，22.05 kHz，804 个说话人，sid 挑嗓子。
 * 名字给人的错觉要说清：eula/baker 这些是「训练目标」，不代表听感；听感由模型 + sid 决定。
 * melo（44.1 kHz 中英混读）曾入选，因延迟最高（~0.5 s）被移除，模型目录可整目录删掉。
 */
export const OFFLINE_VOICES: OfflineVoice[] = [
  { id: 'baker', label: 'Baker（最快）', note: '22.05 kHz，200 ms 级', speed: 1, pitch: 1, sid: 0 },
  { id: 'xiao_ya', label: '小雅', note: '22.05 kHz，包最小', speed: 1, pitch: 1, sid: 0 },
  { id: 'eula', label: 'Eula #5', note: '22.05 kHz，804 人表', speed: 1, pitch: 1, sid: 5 }
]

export function offlineVoicePreset(id: OfflineVoiceId): OfflineVoice {
  return OFFLINE_VOICES.find((voice) => voice.id === id) ?? OFFLINE_VOICES[0]
}
