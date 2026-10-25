/**
 * 朗读可选的嗓子。放 shared 是因为主进程要拿它去合成、面板要拿它渲染下拉——
 * 两边共用一份，才不会出现「面板能选、主进程不认识」的错位。
 */
export interface TtsVoiceOption {
  id: string
  label: string
}

/**
 * 只列**实测能出声**的嗓子。
 *
 * 免费端点的音色集比 Azure 文档小：`zh-CN-XiaomengNeural`/`Xiaohan`/`Xiaochen`/
 * `XiaoxiaoDialects`/`Xiaomo`/`Xiaorui`/`Xiaoyan`/`Xiaozhen`/`Xiaoshuang` 全返回
 * 空音频，`Synthesize` 直接回 `Unsupported voice`——「列表里挂着但说不出话」比
 * 「少一个选项」坏得多，所以每加一个都必须先跑 `--tts-voices-probe`。
 *
 * 英文嗓子（Ana/Jenny）同样不进列表：它们读中文回「没有音频」，而本应用只念中文。
 * 标签写「听感」不写官方名：挑嗓子的人不关心它叫什么，只关心像什么。
 */
export const EDGE_VOICES: TtsVoiceOption[] = [
  { id: 'zh-TW-HsiaoChenNeural', label: '曉臻 · 台湾' },
  { id: 'zh-TW-HsiaoYuNeural', label: '曉雨 · 台湾' },
  { id: 'zh-CN-XiaoxuanNeural', label: '晓萱 · 播音' },
  { id: 'zh-CN-XiaoyiNeural', label: '晓伊 · 沉稳' },
  { id: 'zh-CN-XiaoxiaoNeural', label: '晓晓 · 温暖' },
  { id: 'zh-HK-HiuMaanNeural', label: '曉曼 · 粤语' },
  { id: 'zh-HK-HiuGaaiNeural', label: '曉佳 · 粤语' },
  { id: 'zh-CN-liaoning-XiaobeiNeural', label: '小北 · 东北话' },
  { id: 'zh-CN-shaanxi-XiaoniNeural', label: '晓妮 · 陕西话' },
  { id: 'zh-CN-YunxiNeural', label: '云希 · 少年男' },
  { id: 'zh-CN-YunjianNeural', label: '云健 · 解说男' },
  { id: 'zh-CN-YunyangNeural', label: '云扬 · 播音男' },
  { id: 'zh-TW-YunJheNeural', label: '雲哲 · 台湾男' }
]

export const DEFAULT_EDGE_VOICE = 'zh-CN-XiaoxiaoNeural'

/**
 * 音高倍率 → Edge 的 pitch 参数。
 * 单位必须是 Hz 不是百分比：库里的校验只认 '-100Hz 到 +100Hz' 或纯数字，
 * 传 '+10%' 会立刻抛 Invalid pitch format（一句都不出声，还不报网络错）。
 * 1.0 = 原声；1.3 约 +45Hz（明显更高），0.7 约 -45Hz（更沉）。
 */
export function pitchSpec(pitch: number): string {
  const clamped = Math.min(1.3, Math.max(0.7, Number.isFinite(pitch) ? pitch : 1))
  const hz = Math.round((clamped - 1) * 150)
  return `${hz > 0 ? '+' : ''}${hz}Hz`
}

/** 语速倍率 → Edge 的 rate 参数。0.5–2.0，1.0 = 正常。 */
export function rateSpec(rate: number): string {
  const clamped = Math.min(2, Math.max(0.5, Number.isFinite(rate) ? rate : 1))
  const delta = Math.round((clamped - 1) * 100)
  return delta === 0 ? '+0%' : `${delta > 0 ? '+' : ''}${delta}%`
}
