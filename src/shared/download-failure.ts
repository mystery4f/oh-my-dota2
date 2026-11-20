/**
 * 下载失败到底是谁的错：网络，还是源站。
 *
 * 为什么值得单独一个纯函数：用户报「下不动」时，一句 「下载失败」 什么都回答不了——
 * 是墙掐了连接（换镜像有用），还是源站上根本没这个文件（换哪个镜像都白搭）。
 * 这两类的处置办法完全相反，所以判定必须集中写一次、可离线断言，
 * 而不是每个调用口自己拼一句 error 文案。
 */

export type DownloadFailureKind = 'network' | 'source' | 'unknown'

export interface DownloadFailure {
  kind: DownloadFailureKind
  /** 给用户看的一句话；带「网络」「源站」字样，不再是一个光秃秃的 HTTP 码 */
  text: string
}

/** Chromium/Node 的连接类报错：掐断、超时、断流、被 abort。 */
const NETWORK_RE =
  /fetch failed|ECONNRESET|ECONNREFUSED|ECONNABORTED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ERR_[A-Z_]+|socket hang up|network|stall:|aborted|terminated/i

/** 源站/文件本身的错：HTTP 状态码、尺寸对不上、内容不符。 */
const SOURCE_RE = /HTTP \d{3}|size mismatch|too small|incomplete|hash|sha256|校验|not found|404/i

/**
 * 判断失败归属。
 * 两边都像时认「网络」——源站回错码本身往往就是被中间设备改写的，
 * 先按网络处理（换镜像重试）代价最小，代价大的「源站坏了」不轻易往外说。
 */
export function judgeDownloadFailure(message: string): DownloadFailure {
  const text = message.trim() === '' ? '未知错误' : message.trim()
  if (NETWORK_RE.test(text)) return { kind: 'network', text: `网络：${text}` }
  if (SOURCE_RE.test(text)) return { kind: 'source', text: `源站：${text}` }
  return { kind: 'unknown', text: `原因不明：${text}` }
}
