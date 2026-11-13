import { createServer, type Server } from 'node:http'
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { probeCases, exitProbe } from './harness'
import {
  type ModelFileSizes,
  type VoiceRuntimeJson,
  hfMirrorFileUrl,
  joinNodePath,
  modelStateFromDisk,
  nodeCandidates,
  parseRuntimeJson,
  pendingModelFiles,
  runtimeStateFromDisk
} from '@shared/voice-runtime'
import { downloadResumable } from '../services/net/download'
import { sha256File } from '../services/voice/runtime'

/**
 * `--voice-runtime-probe`：语音运行时（#45）的两层行为锁。
 * 纯规则（NODE_PATH 拼接/node 候选/三态推导/下载清单/hf 直链/runtime.json 解析）
 * 真机/打包后的安装链（拷包 + tar 解 node.exe）是人工验收，不在这里模拟。
 */

interface Row {
  name: string
  ok: boolean
  detail: string
}

const cases: Row[] = []

const { push } = probeCases(cases)

async function withServer(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void, run: (url: string) => Promise<void>): Promise<void> {
  const server: Server = createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  try {
    await run(`http://127.0.0.1:${port}`)
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()))
  }
}

export async function runVoiceRuntimeProbe(): Promise<void> {
  // —— NODE_PATH / node 候选 ——
  push(
    'joinNodePath：运行时前置，已有 NODE_PATH 保留在后',
    joinNodePath('R:\\nm', 'C:\\a; C:\\b ;') === 'R:\\nm;C:\\a;C:\\b',
    joinNodePath('R:\\nm', 'C:\\a; C:\\b ;')
  )
  push('joinNodePath：无 existing → 只剩运行时', joinNodePath('R:\\nm') === 'R:\\nm', joinNodePath('R:\\nm'))
  const savedEnvNode = process.env.OHMYDOTA2_NODE
  delete process.env.OHMYDOTA2_NODE
  push('nodeCandidates：默认运行时优先、PATH 兜底', JSON.stringify(nodeCandidates('R\\node.exe')) === JSON.stringify(['R\\node.exe', 'node']), JSON.stringify(nodeCandidates('R\\node.exe')))
  process.env.OHMYDOTA2_NODE = 'E\\manual.exe'
  push(
    'nodeCandidates：OHMYDOTA2_NODE 插中间',
    JSON.stringify(nodeCandidates('R\\node.exe')) === JSON.stringify(['R\\node.exe', 'E\\manual.exe', 'node']),
    JSON.stringify(nodeCandidates('R\\node.exe'))
  )
  if (savedEnvNode === undefined) delete process.env.OHMYDOTA2_NODE
  else process.env.OHMYDOTA2_NODE = savedEnvNode

  // —— runtime.json 解析 ——
  const goodJson: VoiceRuntimeJson = { nodeVersion: 'v22.21.0', installedAt: 1700000000000, nodeZipSha256: 'ab'.repeat(32) }
  push(
    'parseRuntimeJson：合法三字段全收',
    JSON.stringify(parseRuntimeJson(JSON.stringify(goodJson))) === JSON.stringify(goodJson),
    String(parseRuntimeJson(JSON.stringify(goodJson)) !== null)
  )
  push('parseRuntimeJson：坏 JSON → null', parseRuntimeJson('{oops') === null, String(parseRuntimeJson('{oops')))
  push(
    'parseRuntimeJson：缺 sha256 → null',
    parseRuntimeJson('{"nodeVersion":"v22.21.0","installedAt":1}') === null,
    String(parseRuntimeJson('{"nodeVersion":"v22.21.0","installedAt":1}'))
  )

  // —— 运行时三态 ——
  const full = { nodeExists: true, packagesPresent: { 'sherpa-onnx-node': true, 'sherpa-onnx-win-x64': true }, json: goodJson }
  push('runtimeState：全齐 → ready', runtimeStateFromDisk(full) === 'ready', runtimeStateFromDisk(full))
  push(
    'runtimeState：有 node 无 json（装挂了）→ broken',
    runtimeStateFromDisk({ ...full, json: null }) === 'broken',
    runtimeStateFromDisk({ ...full, json: null })
  )
  push(
    'runtimeState：缺一个插件包 → broken',
    runtimeStateFromDisk({ ...full, packagesPresent: { 'sherpa-onnx-node': true, 'sherpa-onnx-win-x64': false } }) === 'broken',
    'partial packages'
  )
  push(
    'runtimeState：什么都没有 → not-installed',
    runtimeStateFromDisk({ nodeExists: false, packagesPresent: {}, json: null }) === 'not-installed',
    runtimeStateFromDisk({ nodeExists: false, packagesPresent: {}, json: null })
  )

  // —— 模型清单与状态 ——
  const [f0, f1, f2, f3, f4, f5] = ['conv_frontend.onnx', 'encoder.int8.onnx', 'decoder.int8.onnx', 'tokenizer/vocab.json', 'tokenizer/merges.txt', 'tokenizer/tokenizer_config.json']
  const readySizes: ModelFileSizes = { [f0]: 44148281, [f1]: 182491662, [f2]: 755914231, [f3]: 2776833, [f4]: 1671853, [f5]: 12487 }
  push('modelState：六件全齐 → ready', modelStateFromDisk(readySizes).state === 'ready', modelStateFromDisk(readySizes).state)
  const empty = modelStateFromDisk({})
  push('modelState：全缺 → missing 且列全六件', empty.state === 'missing' && empty.missing.length === 6, JSON.stringify(empty.missing))
  const half = modelStateFromDisk({ [f0]: 44148281, [f2]: 123 })
  push('modelState：大小不对也算缺 → partial', half.state === 'partial' && JSON.stringify(half.missing) === JSON.stringify([f1, f2, f3, f4, f5]), JSON.stringify(half.missing))
  const pending = pendingModelFiles({ [f0]: 44148281, [f2]: 123, [`${f2}.part`]: 99999 })
  push(
    'pendingModelFiles：字节对齐的跳过、.part 不算齐、按清单顺序',
    JSON.stringify(pending.map((f) => f.path)) === JSON.stringify([f1, f2, f3, f4, f5]),
    JSON.stringify(pending.map((f) => f.path))
  )
  push(
    'hfMirrorFileUrl：直链形状',
    hfMirrorFileUrl('conv_frontend.onnx') === 'https://hf-mirror.com/csukuangfj2/sherpa-onnx-qwen3-asr-0.6B-int8-2026-03-25/resolve/main/conv_frontend.onnx',
    hfMirrorFileUrl('conv_frontend.onnx')
  )

  // —— 下载副作用（本地假源） ——
  const dir = mkdtempSync(join(tmpdir(), 'omd2-rt-probe-'))
  const payload = Buffer.from('0123456789'.repeat(100)) // 1000 字节，内容可复算哈希
  const payloadSha = createHash('sha256').update(payload).digest('hex')

  await (async () => {
    await withServer(
      (_req, res) => {
        res.setHeader('content-length', String(payload.length))
        res.end(payload)
      },
      async (url) => {
        const dest = join(dir, 'full.bin')
        const got = await downloadResumable({ url, dest, expectedBytes: payload.length })
        const hashOk = sha256File(dest) === payloadSha
        push('下载：200 全量落盘 + sha256 对上', got === payload.length && hashOk, `${got}B sha_ok=${hashOk}`)
        // 已齐再下 → 直接跳过（重进不重下）
        const again = await downloadResumable({ url, dest, expectedBytes: payload.length })
        push('下载：已齐再点 → 秒回不重下', again === payload.length, String(again))
      }
    )

    await withServer(
      (req, res) => {
        const range = req.headers.range as string | undefined
        const start = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0
        res.setHeader('accept-ranges', 'bytes')
        res.statusCode = start > 0 ? 206 : 200
        if (start > 0) res.setHeader('content-range', `bytes ${start}-${payload.length - 1}/${payload.length}`)
        res.setHeader('content-length', String(payload.length - start))
        res.end(payload.subarray(start))
      },
      async (url) => {
        const dest = join(dir, 'resume.bin')
        writeFileSync(`${dest}.part`, payload.subarray(0, 400))
        const got = await downloadResumable({ url, dest, expectedBytes: payload.length })
        const hashOk = sha256File(dest) === payloadSha
        push('下载：.part 续传（206）补齐且哈希对', got === payload.length && hashOk && !existsSyncPart(`${dest}.part`), `${got}B sha_ok=${hashOk}`)
      }
    )

    await withServer(
      (_req, res) => {
        res.setHeader('content-length', String(payload.length - 10))
        res.end(payload.subarray(0, payload.length - 10))
      },
      async (url) => {
        const dest = join(dir, 'short.bin')
        let threw = ''
        try {
          await downloadResumable({ url, dest, expectedBytes: payload.length })
        } catch (err) {
          threw = String((err as Error).message).slice(0, 60)
        }
        push('下载：长度不符 → 抛错', threw.length > 0, threw)
      }
    )
  })()
    // —— 分段并发下载（Range 全支持的假源） ——
    await (async () => {
      const fullRange = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
        const m = /bytes=(\d+)-(\d*)/.exec((req.headers.range as string | undefined) ?? '')
        if (!m) {
          res.setHeader('accept-ranges', 'bytes')
          res.setHeader('content-length', String(payload.length))
          res.end(payload)
          return
        }
        const start = Number(m[1])
        const end = m[2] === '' ? payload.length - 1 : Math.min(Number(m[2]), payload.length - 1)
        res.statusCode = 206
        res.setHeader('content-range', `bytes ${start}-${end}/${payload.length}`)
        res.setHeader('content-length', String(end - start + 1))
        res.end(payload.subarray(start, end + 1))
      }
      // 整链：3 段并发拼装、段文件清走、进度终点到 100%
      await withServer(fullRange, async (url) => {
        const dest = join(dir, 'parallel.bin')
        const seen: Array<[number, number]> = []
        const got = await downloadResumable({
          url,
          dest,
          expectedBytes: payload.length,
          minParallelBytes: 100,
          concurrency: 3,
          onProgress: (done, total) => seen.push([done, total])
        })
        const hashOk = sha256File(dest) === payloadSha
        const partsLeft = existsSyncPart(`${dest}.part-0`) || existsSyncPart(`${dest}.part-1`) || existsSyncPart(`${dest}.part-2`)
        const last = seen.at(-1)
        push(
          '下载：分段并发整链 → 拼装完整、段文件清走、进度到头',
          got === payload.length && hashOk && !partsLeft && last?.[0] === payload.length && last?.[1] === payload.length,
          `${got}B sha_ok=${hashOk} parts_left=${partsLeft} last=${JSON.stringify(last ?? null)}`
        )
      })
      // 断点：三段里两段已在盘 → 只补缺口（concurrency 3、段长 334：seg0/seg2 齐，seg1 差 434-667）
      await withServer(fullRange, async (url) => {
        const dest = join(dir, 'parallel-resume.bin')
        writeFileSync(`${dest}.part-0`, payload.subarray(0, 334))
        writeFileSync(`${dest}.part-1`, payload.subarray(334, 434))
        writeFileSync(`${dest}.part-2`, payload.subarray(668))
        const got = await downloadResumable({ url, dest, expectedBytes: payload.length, minParallelBytes: 100, concurrency: 3 })
        const hashOk = sha256File(dest) === payloadSha
        push('下载：分段断点 → 只补缺口拼装完整', got === payload.length && hashOk, `${got}B sha_ok=${hashOk}`)
      })
      // 旧单流 .part 是文件前缀 → 按段界播种给各段，断点不浪费
      await withServer(fullRange, async (url) => {
        const dest = join(dir, 'parallel-seed.bin')
        writeFileSync(`${dest}.part`, payload.subarray(0, 600))
        const got = await downloadResumable({ url, dest, expectedBytes: payload.length, minParallelBytes: 100, concurrency: 3 })
        const hashOk = sha256File(dest) === payloadSha
        const legacyGone = !existsSyncPart(`${dest}.part`)
        push('下载：旧 .part 前缀按段播种 → 不浪费断点', got === payload.length && hashOk && legacyGone, `${got}B sha_ok=${hashOk} legacy_gone=${legacyGone}`)
      })
      // 服务端不认 Range（永远 200 全量）→ 探针失败退回单流，照样落盘
      await withServer(
        (_req, res) => {
          res.setHeader('content-length', String(payload.length))
          res.end(payload)
        },
        async (url) => {
          const dest = join(dir, 'parallel-fallback.bin')
          const got = await downloadResumable({ url, dest, expectedBytes: payload.length, minParallelBytes: 1 })
          const hashOk = sha256File(dest) === payloadSha
          push('下载：不认 Range → 退回单流落盘', got === payload.length && hashOk, `${got}B sha_ok=${hashOk}`)
        }
      )
    })()


  rmSync(dir, { recursive: true, force: true })

  let failed = 0
  for (const item of cases) {
    if (!item.ok) failed++
    console.log(`${item.ok ? 'PASS' : 'FAIL'} | ${item.name} | ${item.detail}`)
  }
  console.log(`VOICE_RUNTIME_PROBE ${cases.length - failed}/${cases.length} PASS`)
  exitProbe(!(failed > 0), cases)
}

function existsSyncPart(path: string): boolean {
  try {
    statSync(path)
    return true
  } catch {
    return false
  }
}

