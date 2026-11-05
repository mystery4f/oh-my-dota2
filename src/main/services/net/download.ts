import { createWriteStream, existsSync, mkdirSync, renameSync, statSync } from 'node:fs'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * 下载只有两个真正不同的形状：一次性的小文件、可续传的大文件。
 *
 * 此前四个下载口（离线音色、GPT-SoVITS 安装包、音色包、whisper 模型）各写一遍：
 * 镜像前缀表只在一个地方有、停滞看门狗只在一个地方有、`.part` 续传只在一个地方有、
 * 完整性校验尺寸口径三处不同。「下载失败」在这个项目里是常态（国内直连 GitHub），
 * 每个口子自己发明一套重试策略，等于用户每次遇到的是不同的失败。
 *
 * 这里只收两件事：镜像与看门狗策略（tryMirrors）、可续传落盘（downloadResumable）。
 * whisper 的并行分块下载是第三种形状（并发 + 分片拼装），刻意留在原处并注明，
 * 别为了「统一」把它的并发优势换掉。
 */

/** GitHub 直连在国内常被掐；前面空串是直连，失败再依次试加速前缀。 */
export const GITHUB_MIRRORS = ['', 'https://gh-proxy.com/', 'https://ghfast.top/']

function mirrorUrl(url: string, prefix: string): string {
  return prefix === '' || !/^https?:\/\//i.test(url) ? url : `${prefix}${url}`
}

/**
 * 依次试直连与镜像，全失败时抛出最后一个原因。
 * 每个候选只试一次——真正的重试语义在调用方（续传靠 .part，不靠重放整个请求）。
 */
export async function tryMirrors<T>(
  url: string,
  attempt: (candidate: string, prefix: string) => Promise<T>,
  options: { mirrors?: string[]; onError?: (candidate: string, error: string) => void } = {}
): Promise<T> {
  let lastError = 'unknown'
  for (const prefix of options.mirrors ?? GITHUB_MIRRORS) {
    const candidate = mirrorUrl(url, prefix)
    try {
      return await attempt(candidate, prefix)
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      options.onError?.(candidate, lastError)
    }
  }
  throw new Error(lastError)
}

export interface DownloadOptions {
  url: string
  /** 最终落盘路径；过程中写 `<dest>.part` */
  dest: string
  /** 期望总字节：对不上就是错（音色包这类有权威尺寸的文件） */
  expectedBytes?: number
  /** 合理的下限：小于它判失败（安装包只校验量级，不校验精确值） */
  minBytes?: number
  /** 多久没有新字节就掐断，缺省 0 = 不掐；已落盘的字节留在 .part 里等续传 */
  stallMs?: number
  /** 字节进度（续传时从已有字节开始） */
  onProgress?: (done: number, total: number) => void
  /** 进度日志间隔（字节），配合 onProgressLog 使用 */
  progressLogEvery?: number
  onProgressLog?: (done: number, total: number) => void
  /** 续传/重下的可观测信号 */
  onLog?: (tag: 'RESUME' | 'RESTART', detail: Record<string, unknown>) => void
}

/** 解析 content-range「bytes 100-199/1000」；不合法返回 null。 */
export function parseContentRange(header: string | null): { start: number; total: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header ?? '')
  if (!match) return null
  return { start: Number(match[1]), total: Number(match[3]) }
}

/**
 * 可续传下载：`.part` 在就带 Range 接着下（魔搭/加速前缀都认 206），
 * 服务端不认 Range 就从零重下（不在残片上叠脏数据），下完原子改名。
 * @returns 最终字节数
 */
export async function downloadResumable(options: DownloadOptions): Promise<number> {
  const { dest } = options
  mkdirSync(dirname(dest), { recursive: true })
  const part = `${dest}.part`
  if (options.expectedBytes !== undefined && existsSync(dest) && statSync(dest).size === options.expectedBytes) {
    return options.expectedBytes
  }
  const partBytes = existsSync(part) ? statSync(part).size : 0
  const response = await fetch(options.url, partBytes > 0 ? { headers: { Range: `bytes=${partBytes}-` } } : undefined)
  const floor = options.minBytes ?? options.expectedBytes ?? Number.POSITIVE_INFINITY
  if (response.status === 416 && partBytes >= floor) {
    // 残片已经够大：服务端拒续传，但文件本身大概率是齐的，直接收尾。
    renameSync(part, dest)
    return partBytes
  }
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)

  const range = parseContentRange(response.headers.get('content-range'))
  const total = response.status === 206 && range ? range.total : Number(response.headers.get('content-length') ?? 0)
  const appendable = response.status === 206 && range !== null && range.start === partBytes
  let done = 0
  if (appendable) {
    done = partBytes
    options.onLog?.('RESUME', { fromBytes: partBytes, total })
  } else if (partBytes > 0) {
    options.onLog?.('RESTART', { partBytes, status: response.status })
  }

  const source = Readable.fromWeb(response.body as never)
  let lastChunkAt = Date.now()
  let reported = done
  const stallMs = options.stallMs ?? 0
  const stall =
    stallMs > 0
      ? setInterval(() => {
          if (Date.now() - lastChunkAt > stallMs) source.destroy(new Error(`stall: no bytes for ${stallMs / 1000}s`))
        }, Math.min(5_000, Math.max(500, Math.floor(stallMs / 4))))
      : null
  source.on('data', (chunk: Buffer) => {
    done += chunk.length
    lastChunkAt = Date.now()
    options.onProgress?.(done, total)
    if (options.progressLogEvery && done - reported >= options.progressLogEvery) {
      reported = done
      options.onProgressLog?.(done, total)
    }
  })
  try {
    await pipeline(source, createWriteStream(part, { flags: appendable ? 'a' : 'w' }))
    if (options.expectedBytes !== undefined && done !== options.expectedBytes) {
      throw new Error(`size mismatch: ${done}/${options.expectedBytes}`)
    }
    if (done < floor) throw new Error(`download too small: ${done}`)
    if (total > 0 && done < total) throw new Error(`download incomplete: ${done}/${total}`)
    renameSync(part, dest)
    return done
  } finally {
    if (stall) clearInterval(stall)
  }
}
