import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { errorMessage } from '@shared/errors'
import { once } from 'node:events'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

/**
 * 下载只有两个真正不同的形状：一次性的小文件、可续传的大文件；
 * 大文件里再分「单流续传」和「多连接分段」两条腿。
 *
 * 此前四个下载口（离线音色、GPT-SoVITS 安装包、音色包、whisper 模型）各写一遍：
 * 镜像前缀表只在一个地方有、停滞看门狗只在一个地方有、`.part` 续传只在一个地方有、
 * 完整性校验尺寸口径三处不同。「下载失败」在这个项目里是常态（国内直连 GitHub），
 * 每个口子自己发明一套重试策略，等于用户每次遇到的是不同的失败。
 *
 * 这里收三件事：镜像与看门狗策略（tryMirrors）、可续传落盘（downloadResumable）、
 * 大文件多连接分段下载（downloadParallel，downloadResumable 内部按体积分流）。
 * 单条连接常被服务端限速（hf-mirror/魔搭 CDN 单流 2–6 MB/s），分段并发能把
 * 986 MB 的 Qwen3 底模从约 5 分钟压到 1 分钟量级。whisper 时代的「并发分块」形状
 * 就地收编进这里，不再各处自己写。
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
      lastError = errorMessage(err)
      options.onError?.(candidate, lastError)
    }
  }
  throw new Error(lastError)
}

export interface DownloadOptions {
  url: string
  /** 最终落盘路径；单流过程写 `<dest>.part`，分段并发另有 `<dest>.part-<i>` 段文件 */
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
  /** 分段并发连接数，缺省 6，夹在 2–8 */
  concurrency?: number
  /** 大于这个字节数才走分段并发，缺省 16 MB；探针传小值来在小文件上测并发路径 */
  minParallelBytes?: number
}

/** 解析 content-range「bytes 100-199/1000」；不合法返回 null。 */
export function parseContentRange(header: string | null): { start: number; total: number } | null {
  const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(header ?? '')
  if (!match) return null
  return { start: Number(match[1]), total: Number(match[3]) }
}

/**
 * 可续传下载的总入口：先探一针服务端认不认 Range；
 * 认且文件够大走分段并发（downloadParallel），否则退回单流续传。
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
  const threshold = options.minParallelBytes ?? 16 * 1024 * 1024
  const sizeCandidate = options.expectedBytes ?? (await probeTotal(options.url))
  if (sizeCandidate !== null && sizeCandidate >= threshold) {
    try {
      return await downloadParallel(options, sizeCandidate, part)
    } catch (err) {
      // 分段路径的失败（某段中途断流）不该终结整个下载：退回单流再试一次。
      options.onLog?.('RESTART', { reason: 'parallel-fallback', error: errorMessage(err) })
    }
  }
  return downloadSingle(options, part)
}

/** 探针请求：`Range: bytes=0-0`，206 才说明服务端支持分段；200/其他一律按不支持处理。返回总字节或 null。 */
async function probeTotal(url: string): Promise<number | null> {
  try {
    const probe = await fetch(url, { headers: { Range: 'bytes=0-0' } })
    try {
      if (probe.status === 206) {
        const range = parseContentRange(probe.headers.get('content-range'))
        if (range && range.total > 0) return range.total
      }
      return null
    } finally {
      await probe.body?.cancel().catch(() => undefined)
    }
  } catch {
    return null
  }
}

/** 单流续传：`.part` 在就带 Range 接着下（魔搭/加速前缀都认 206），下完原子改名。 */
async function downloadSingle(options: DownloadOptions, part: string): Promise<number> {
  const partBytes = existsSync(part) ? statSync(part).size : 0
  const response = await fetch(options.url, partBytes > 0 ? { headers: { Range: `bytes=${partBytes}-` } } : undefined)
  const floor = options.minBytes ?? options.expectedBytes ?? Number.POSITIVE_INFINITY
  if (response.status === 416 && partBytes >= floor) {
    // 残片已经够大：服务端拒续传，但文件本身大概率是齐的，直接收尾。
    renameSync(part, options.dest)
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
    renameSync(part, options.dest)
    return done
  } finally {
    if (stall) clearInterval(stall)
  }
}

interface SegmentPlan {
  /** 本段在全文件里的闭开区间 [start, end) */
  start: number
  end: number
  partFile: string
  done: number
}

/**
 * 分段并发下载：切成 K 段并发拉，每段各自 `<dest>.part-<i>` 落盘（段文件大小就是该段进度，
 * 断点恢复天然按段对账），全部到齐后按序拼装、原子改名。旧版单流 `.part` 是文件前缀，
 * 按段界切开分还各段当进度，老断点不浪费。任何一段失败即中止其余段并抛出，
 * 已落盘的段进度保留，下次调用接着跑。
 */
async function downloadParallel(options: DownloadOptions, total: number, legacyPart: string): Promise<number> {
  const concurrency = Math.min(8, Math.max(2, options.concurrency ?? 6))
  // 段数就是并发数（封顶 8），不再按 4MB 下限缩段——缩段会让段界漂移，
  // 已落盘的 .part-<i> 断点文件就对不上号；小文件本来走不到这里。
  const segments = concurrency
  const segSize = Math.ceil(total / segments)

  const plans: SegmentPlan[] = []
  for (let i = 0; i < segments; i++) {
    const start = i * segSize
    const end = Math.min(start + segSize, total)
    if (start >= end) break
    plans.push({ start, end, partFile: `${options.dest}.part-${i}`, done: 0 })
  }

  // 旧单流 .part 是前缀：按段界切开分给各段当已下载进度。
  if (existsSync(legacyPart)) {
    const legacyBytes = statSync(legacyPart).size
    for (const plan of plans) {
      const covered = Math.min(legacyBytes - plan.start, plan.end - plan.start)
      if (covered <= 0) break
      await seedSegment(legacyPart, plan.partFile, plan.start, covered)
      plan.done = covered
    }
    if (legacyBytes > 0) options.onLog?.('RESUME', { fromBytes: Math.min(legacyBytes, total), total, mode: 'parallel-seeded' })
    rmSync(legacyPart, { force: true })
  }
  for (const plan of plans) {
    const segLen = plan.end - plan.start
    if (!existsSync(plan.partFile)) continue
    const bytes = statSync(plan.partFile).size
    if (bytes > segLen) {
      // 超长段是脏数据（换过并发数/总长），宁可重下这段也不叠错字节。
      rmSync(plan.partFile, { force: true })
      plan.done = 0
    } else {
      plan.done = bytes
    }
  }
  let reported = plans.reduce((sum, plan) => sum + plan.done, 0)
  if (reported > 0) options.onLog?.('RESUME', { fromBytes: reported, total, mode: 'parallel' })

  const controller = new AbortController()
  const lastChunkAt = plans.map(() => Date.now())
  const stallMs = options.stallMs ?? 0
  const stall =
    stallMs > 0
      ? setInterval(() => {
          const now = Date.now()
          const idle = Math.min(...lastChunkAt.map((at) => now - at))
          if (idle > stallMs) controller.abort(new Error(`stall: no bytes for ${stallMs / 1000}s`))
        }, Math.min(5_000, Math.max(500, Math.floor(stallMs / 4))))
      : null

  const segmentDone = () => plans.reduce((sum, plan) => sum + plan.done, 0)

  try {
    await runPool(plans, async (plan, index) => {
      const segLen = plan.end - plan.start
      const out = createWriteStream(plan.partFile, { flags: 'a' })
      try {
        while (plan.done < segLen) {
          if (controller.signal.aborted) throw new Error('aborted')
          const rangeStart = plan.start + plan.done
          const response = await fetch(options.url, {
            headers: { Range: `bytes=${rangeStart}-${plan.end - 1}` },
            signal: controller.signal
          })
          try {
            if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
            const range = parseContentRange(response.headers.get('content-range'))
            if (response.status !== 206 || !range || range.start !== rangeStart || range.total !== total) {
              throw new Error(`range echo mismatch: ${response.status} ${range ? `${range.start}/${range.total}` : 'no-range'}`)
            }
            const source = Readable.fromWeb(response.body as never)
            for await (const chunk of source) {
              plan.done += (chunk as Buffer).length
              lastChunkAt[index] = Date.now()
              if (!out.write(chunk as Buffer)) await once(out, 'drain')
              const done = segmentDone()
              options.onProgress?.(done, total)
              if (options.progressLogEvery && done - reported >= options.progressLogEvery) {
                reported = done
                options.onProgressLog?.(done, total)
              }
            }
          } finally {
            await response.body?.cancel().catch(() => undefined)
          }
        }
      } catch (err) {
        // 一段失败就停全场：其余段的进度已在各自段文件里，下次接着跑。
        controller.abort(err)
        throw err
      } finally {
        await new Promise<void>((resolve) => out.end(resolve))
      }
    })
    const done = segmentDone()
    if (options.expectedBytes !== undefined && done !== options.expectedBytes) {
      throw new Error(`size mismatch: ${done}/${options.expectedBytes}`)
    }
    if (done !== total) throw new Error(`download incomplete: ${done}/${total}`)
    await concatSegments(plans.map((plan) => plan.partFile), options.dest)
    for (const plan of plans) rmSync(plan.partFile, { force: true })
    return done
  } finally {
    if (stall) clearInterval(stall)
  }
}

/** 定长并发池：K 条泳道轮流领任务，任何一项抛错就整池收场（其余请求由 AbortController 停）。 */
async function runPool<T>(items: T[], worker: (item: T, index: number) => Promise<void>): Promise<void> {
  const errors: unknown[] = []
  let cursor = 0
  const lanes = Array.from({ length: Math.min(items.length, 8) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      try {
        await worker(items[index], index)
      } catch (err) {
        errors.push(err)
        throw err
      }
    }
  })
  await Promise.allSettled(lanes)
  if (errors.length > 0) throw errors[0]
}

async function seedSegment(source: string, dest: string, offset: number, bytes: number): Promise<void> {
  const out = createWriteStream(dest)
  for await (const chunk of createReadStream(source, { start: offset, end: offset + bytes - 1 })) {
    if (!out.write(chunk as Buffer)) await once(out, 'drain')
  }
  await new Promise<void>((resolve) => out.end(resolve))
}

async function concatSegments(partFiles: string[], dest: string): Promise<void> {
  const out = createWriteStream(dest)
  for (const file of partFiles) {
    for await (const chunk of createReadStream(file)) {
      if (!out.write(chunk as Buffer)) await once(out, 'drain')
    }
  }
  await new Promise<void>((resolve) => out.end(resolve))
}
