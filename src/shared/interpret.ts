/**
 * 同声传译腿的纯规则（票 128）：我说中文，队友听到英文。
 *
 * 与语音对讲的区别只有两处，都写在这里，谁读都看得出：
 *   - 英文不是念给自己听的，是**灌进游戏的话筒**（虚拟声卡的输入口），所以不按说话键——
 *     游戏里那台「话筒」一直是开的；按 F5 只会把开麦/关麦切成和音频不同步。
 *   - 自己的耳朵不能空着：整句中文录音在本地回放一遍（渲染层做），你确认刚才那句
 *     到底是从哪句话走的；这里只给出「要不要回放」的判定。
 *
 * 句子是单位：一条对讲链就是一句话，单字/逐词分片会让英文断在半句上。
 */

/** 落在 voice-chain.jsonl 与浮层上的阶段名：同声这一腿自己一条，慢在哪一段才量得出来。 */
export const INTERPRET_STAGE = 'interpret'

export interface InterpretPlan {
  /** true = 这句进同声腿；false = 提前收场（原因在 reason）。 */
  speak: boolean
  reason: 'empty-recognition' | 'empty-translation' | null
}

/**
 * 这句能不能灌进游戏话筒：识别为空、译文为空都不灌——空音频灌进去就是一段静音，
 * 队友那边只听到「他开麦了但没说话」。
 */
export function interpretPlanOf(input: { recognized: string; translated: string | null }): InterpretPlan {
  if (input.recognized.trim() === '') return { speak: false, reason: 'empty-recognition' }
  if (input.translated === null || input.translated.trim() === '') return { speak: false, reason: 'empty-translation' }
  return { speak: true, reason: null }
}

/** 一条腿怎么播：设备、按不按说话键、本机要不要再放一遍。 */
export interface InterpretLeg {
  /** 灌哪台设备（空串 = 系统默认输出）。 */
  device: string
  /** 不按说话键：游戏话筒是常开的虚拟声卡，按键只会让开麦和音频错拍。 */
  keyless: boolean
  /** 本机监听关掉：中文回放由渲染层拿原始录音放，英文再放一遍就是两种语言打架。 */
  monitorLocal: boolean
}

/**
 * 设备优先级：面板专门选的同声话筒 > 声出输出设备。
 * 后者已经按「有没有虚拟声卡」验过一遍（voice-out 的 CABLE 判定），
 * 已经设成 CABLE 的安装升级后直接可用，不用再配一次。
 */
export function interpretLegOf(input: { interpretInDevice: string; ttsOutputDevice: string }): InterpretLeg {
  const picked = input.interpretInDevice.trim()
  return { device: picked === '' ? input.ttsOutputDevice : picked, keyless: true, monitorLocal: false }
}

/** 面板那一行说什么：选好的设备名字，或者「还没选」。 */
export function interpretDeviceLine(label: string): string {
  const name = label.trim()
  if (name === '') return '还没选游戏话筒：先把 Dota 2 的麦克风设成虚拟声卡的输出，再回这里点一下'
  return `游戏话筒 ← ${name}`
}
