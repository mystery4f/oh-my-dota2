/**
 * 语音队列（#88）：正在读哪句、后头还压着几句、停止时清掉了几单。
 *
 * 口径只有一处：真相在主进程的 `speech-pipeline`（它才握着 lanes），面板只画这里给出的数，
 * 不自己数、不自己猜「是不是在读」——所以句子文案也是纯函数，探针能钉住。
 * 停止的语义写在 `stopSpeech`：正在读的那句读到段边界就停，排队的当场结账，停止之后新的一句照常读满。
 * @author dongcheng.xie
 */

/** 一条投递通道上的待读：`key` 是通道名（`read` / `sovits` / 声出单发不排队所以不出现）。 */
export interface SpeechQueueLane {
  key: string
  /** 这条通道上还没开始投递的句子数。 */
  pending: number
  /** 排在最前头那句的开头（面板 hover 用；空闲时是空串）。 */
  text: string
}

export interface SpeechQueueSnapshot {
  /** 正在投递的那一句（原文，未截断）；空闲时 null。 */
  speaking: string | null
  /** 还没开始投递的句子数，不含正在投递的那句。 */
  pending: number
  lanes: SpeechQueueLane[]
}

export interface SpeechStopResult {
  /** 清掉的排队单数（当场结账，调用方不等一场空）。 */
  cleared: number
  /** 是否有正在读的句子被打断（它会读到当前这段的段尾再停）。 */
  interrupted: boolean
}

/** 面板一行字里给正在读那句留的字数：再长就吞掉，原文在快照里没动。 */
const SPEAKING_PREVIEW = 14

const clip = (text: string): string =>
  text.length > SPEAKING_PREVIEW ? `${text.slice(0, SPEAKING_PREVIEW)}…` : text

/**
 * 面板那一行字：`空闲` / `正在读「…」` / `正在读「…」 · 余 N 句`。
 * 只有「正在读」和「余几」两个事实，不写「队列健康」这类没有分母的判断。
 */
export function queueLine(snapshot: SpeechQueueSnapshot): string {
  const speaking = snapshot.speaking ? `正在读「${clip(snapshot.speaking)}」` : ''
  if (!speaking) return snapshot.pending > 0 ? `余 ${snapshot.pending} 句待读` : '空闲'
  return snapshot.pending > 0 ? `${speaking} · 余 ${snapshot.pending} 句` : speaking
}

/** 按了停止之后那句话：说清「停到哪一步」，不假装当场静音。 */
export function stopLine(result: SpeechStopResult): string {
  const parts: string[] = []
  if (result.interrupted) parts.push('这句读到段尾')
  if (result.cleared > 0) parts.push(`清掉 ${result.cleared} 句排队`)
  return parts.length > 0 ? parts.join(' · ') : '本来就没在说'
}
