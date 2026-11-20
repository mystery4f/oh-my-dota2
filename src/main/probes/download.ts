import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AddressInfo } from 'node:net'
import { probeCases, exitProbe } from './harness'
import { downloadResumable, tryMirrors } from '../services/net/download'

/**
 * 下载探针（--download-probe）：本地起一个会「中途断流」的 HTTP 服务，钉三件事。
 *
 * 这三件事都是用户真实遇到的失败，却一直只在真网里偶发，没有一处能在离线复现：
 * 断线之后是从头再拉一遍，还是接着残片；服务端不认 Range 时会不会把残片叠成脏文件；
 * 一个镜像坏了会不会换下一个、并且日志里能查出「这次用的是谁」。
 *
 * 全部跑在 127.0.0.1 的临时端口上，不出网、不写用户数据目录（临时目录跑完就删）。
 */

const TOTAL = 256 * 1024
/** 第一次响应写到这里就掐断，模拟「下到一半连接没了」。 */
const CUT_AT = 96 * 1024

interface Seen {
  path: string
  range: string | null
}

function body(fill: number): Buffer {
  const buf = Buffer.alloc(TOTAL)
  for (let i = 0; i < TOTAL; i++) buf[i] = (i * 7 + fill) % 251
  return buf
}

const PAYLOAD = body(3)

function rangeStart(header: string | null): number | null {
  const match = /^bytes=(\d+)-/.exec(header ?? '')
  return match ? Number(match[1]) : null
}

/**
 * 一个「只认 Range、但第一次会断流」的服务端。
 * `/cut/…` 首次无 Range 请求写 CUT_AT 字节后 destroy；带 Range 的请求正常 206。
 * `/norange/…` 一律 200 全量（模拟不认 Range 的源）。
 * `/bad/…` 一律 500（模拟坏镜像）。
 * `/proxy/<原始 URL 的路径>` 原样转给内部处理器（模拟加速前缀）。
 */
function makeServer(seen: Seen[]): Server {
  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    const url = req.url ?? '/'
    seen.push({ path: url, range: req.headers.range ?? null })
    if (url.startsWith('/bad/') || url.includes('/bad/')) {
      res.writeHead(500)
      res.end('bad mirror')
      return
    }
    const inner = url.includes('/proxy/') ? url.slice(url.indexOf('/proxy/') + '/proxy/'.length) : url
    const pathname = inner.replace(/^https?:\/\/[^/]+/, '')
    if (pathname.startsWith('/norange/')) {
      res.writeHead(200, { 'content-length': String(TOTAL) })
      res.end(PAYLOAD)
      return
    }
    if (pathname.startsWith('/cut/') || pathname.startsWith('/plain/')) {
      const start = rangeStart(req.headers.range ?? null)
      if (pathname.startsWith('/cut/') && start === null) {
        // 第一次：宣告全长但只写 CUT_AT 字节就收尾（Connection: close 保证对端立刻读到 EOF）。
        // 不用 res.destroy()：Electron 的 fetch 走 Chromium 网络服务，RST 会把它内部
        // loader 的 promise 变成无人接的 rejection，整个探针挂住（实测）。
        res.writeHead(200, { 'content-length': String(TOTAL), 'connection': 'close' })
        res.end(PAYLOAD.subarray(0, CUT_AT))
        return
      }
      const from = start ?? 0
      const slice = PAYLOAD.subarray(from)
      res.writeHead(start === null ? 200 : 206, {
        'content-length': String(slice.length),
        ...(start === null ? {} : { 'content-range': `bytes ${from}-${TOTAL - 1}/${TOTAL}` })
      })
      res.end(slice)
      return
    }
    res.writeHead(404)
    res.end('nope')
  }
  return createServer(handler)
}

export function runDownloadProbe(): void {
  const dir = mkdtempSync(join(tmpdir(), 'omd2-download-'))
  const seen: Seen[] = []
  const server = makeServer(seen)
  const { cases, push } = probeCases()

  const guard = setTimeout(() => {
    console.log('DOWNLOAD_PROBE_TIMEOUT 探针 60 秒没走完，强制收场')
  }, 60_000)
  const finish = (): void => {
    clearTimeout(guard)
    server.close()
    rmSync(dir, { recursive: true, force: true })
    const failed = cases.filter((item) => !item.ok)
    for (const item of cases) console.log(`${item.ok ? 'PASS' : 'FAIL'} ${item.name} ${item.detail ?? ''}`)
    console.log(
      `DOWNLOAD_PROBE ${JSON.stringify({ ok: failed.length === 0 && cases.length > 0, passed: cases.length - failed.length, failed: failed.length })}`
    )
    exitProbe(!(failed.length > 0), cases)
  }

  server.listen(0, '127.0.0.1', () => {
    const port = (server.address() as AddressInfo).port
    const base = `http://127.0.0.1:${port}`
    void main(base, dir, seen, push, finish).catch((err) => {
      console.log('DOWNLOAD_PROBE_CRASH', err instanceof Error ? err.message : String(err))
      finish()
    })
  })
}

type Check = (name: string, ok: boolean, detail?: string) => void

async function main(base: string, dir: string, seen: Seen[], check: Check, finish: () => void): Promise<void> {

  // —— 一、断流后续传：第二次请求必须带 Range，且从残片接着下 ——
  const dest = join(dir, 'cut.bin')
  const logs: string[] = []
  try {
    await downloadResumable({
      url: `${base}/cut/file.bin`,
      dest,
      expectedBytes: TOTAL,
      minParallelBytes: Number.MAX_SAFE_INTEGER,
      onLog: (tag, detail) => logs.push(`${tag}:${JSON.stringify(detail)}`)
    })
    check('断流：第一次调用该失败（服务端掐断）', false, '居然成功了，说明服务端没断')
  } catch {
    const part = `${dest}.part`
    const partBytes = existsSync(part) ? statSync(part).size : 0
    check('断流：失败后残片留在 .part 里', partBytes > 0 && partBytes < TOTAL, `${partBytes}/${TOTAL}`)
    const second = await downloadResumable({
      url: `${base}/cut/file.bin`,
      dest,
      expectedBytes: TOTAL,
      minParallelBytes: Number.MAX_SAFE_INTEGER,
      onLog: (tag, detail) => logs.push(`${tag}:${JSON.stringify(detail)}`)
    })
    const rangedRequests = seen.filter((item) => item.range !== null)
    const resumedFrom = rangeStart(rangedRequests[0]?.range ?? null)
    check('断流：第二次请求带 Range（不从头再来）', rangedRequests.length >= 1, JSON.stringify(seen.map((s) => s.range)))
    check(
      '断流：Range 起点等于已落盘字节数',
      resumedFrom !== null && resumedFrom === partBytes,
      `resume=${resumedFrom} part=${partBytes}`
    )
    check('断流：onLog 报了 RESUME 与起点', logs.some((line) => line.startsWith('RESUME:') && line.includes('fromBytes')), logs.join(' | '))
    check('断流：总字节与源一致', second === TOTAL, `${second}/${TOTAL}`)
    const got = readFileSync(dest)
    check('断流：拼出来的内容逐字节等于源', got.length === TOTAL && got.equals(PAYLOAD), `${got.length}`)
  }

  // —— 二、服务端不认 Range：必须从零重下，不许在残片上叠脏字节 ——
  const noRange = join(dir, 'norange.bin')
  rmSync(`${noRange}.part`, { force: true })
  await downloadResumable({
    url: `${base}/norange/file.bin`,
    dest: noRange,
    expectedBytes: TOTAL,
    minParallelBytes: Number.MAX_SAFE_INTEGER
  })
  const noRangeGot = readFileSync(noRange)
  check(
    '不认 Range：整份重下后内容仍然正确',
    noRangeGot.length === TOTAL && noRangeGot.equals(PAYLOAD),
    `${noRangeGot.length}`
  )
  check('不认 Range：落盘就一个文件，没有残留段文件', !existsSync(`${noRange}.part`), `${noRange}.part`)

  // —— 三、坏镜像：掉到下一个，并说清「这次用的是谁」 ——
  const used: string[] = []
  const failures: string[] = []
  const mirrorDest = join(dir, 'mirror.bin')
  const sources = await tryMirrors(
    `${base}/plain/file.bin`,
    async (candidate) => {
      const response = await fetch(candidate)
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      await downloadResumable({ url: candidate, dest: mirrorDest, expectedBytes: TOTAL, minParallelBytes: Number.MAX_SAFE_INTEGER })
      return candidate
    },
    {
      mirrors: [`${base}/bad/`, `${base}/proxy/`, ''],
      onError: (failedCandidate, error) => failures.push(`${failedCandidate} → ${error}`),
      onUsed: (_candidate, prefix) => used.push(prefix)
    }
  )
  check('坏镜像：第一个 500 被记下来，不是静默跳过', failures.length === 1 && failures[0].includes('HTTP 500'), failures.join(' | '))
  check('坏镜像：掉到下一个镜像并成功', used.length === 1 && used[0] === `${base}/proxy/`, JSON.stringify(used))
  check('坏镜像：最终落盘完整', statSync(mirrorDest).size === TOTAL, `${statSync(mirrorDest).size}`)
  check('坏镜像：onUsed 报的就是真正提供字节的那个候选', sources.includes('/proxy/'), sources)

  // —— 四、全挂：错误必须点名最后一次原因，不能只说「下载失败」 ——
  let allBad = ''
  try {
    await tryMirrors(
      `${base}/plain/never.bin`,
      async () => {
        throw new Error('mirror refused')
      },
      { mirrors: [`${base}/bad/`, `${base}/bad2/`] }
    )
  } catch (err) {
    allBad = err instanceof Error ? err.message : String(err)
  }
  check('全挂：抛出的原因点名了是哪一类（网络/源站），不是一句「下载失败」', /^(网络|源站|原因不明)：/.test(allBad) && allBad.includes('mirror refused'), allBad)

  finish()
}
