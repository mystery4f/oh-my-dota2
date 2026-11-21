/**
 * --asr-switch-probe：短句/长句分流换引擎时，识别器到底重建了没有（#142）。
 *
 * 票面实测（改前）：同一段音频，切到 qwen3 要 13228/15352 ms，切回 paraformer 6530 ms——
 * 因为 worker 只有一个识别器槽，键是 `kind|dir|hotwords`，换引擎就是整图重建。
 * 改法是 worker 留两份图（`MAX_RECOGNIZERS = 2`），换引擎只挪指针。
 *
 * 这个探针跑真 worker + 机器上真实的两个模型，所以不能进 CI（Runner 上没有模型）：
 * 模型缺件就 SKIP，报告里写明缺的是谁。断言只认「谁加载了、谁命中了」这种确定事实，
 * 墙钟数字进 JSON 给人看，不当门槛——并发跑探针时它自己就会抖（见 AGENTS.md）。
 */
import { spawn } from 'node:child_process'
import { app } from 'electron'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ASR_ENGINES, type AsrEngineId } from '@shared/asr/engines'
import { exitProbe, finishProbe, probeCases } from './harness'
import { locateWorkerScript, voiceRuntimeNodeBinary } from '../services/voice/runtime'

const { cases, push } = probeCases()
const TAG = 'ASR_SWITCH_PROBE'
/** 探针自己的音频：2 秒 16 kHz 单声道 PCM16 静音。测的是加载与命中，不是识别质量。 */
const CLIP_MS = 2000

interface Reply {
  id: string
  ok?: boolean
  text?: string
  err?: string
}

interface WorkerLine {
  at: number
  text: string
}

function clipPath(dir: string): string {
  const samples = Math.round((16000 * CLIP_MS) / 1000)
  const data = Buffer.alloc(samples * 2)
  const header = Buffer.alloc(44)
  header.write('RIFF', 0, 'ascii')
  header.writeUInt32LE(36 + data.length, 4)
  header.write('WAVEfmt ', 8, 'ascii')
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36, 'ascii')
  header.writeUInt32LE(data.length, 40)
  const file = join(dir, 'silence-2s.wav')
  writeFileSync(file, Buffer.concat([header, data]))
  return file
}

function modelDir(id: AsrEngineId): string {
  const rel = ASR_ENGINES[id].canonicalRel.split('/')
  return join(app.getPath('userData'), ...rel)
}

export async function runAsrSwitchProbe(): Promise<void> {
  const dirs: Record<string, string> = {
    qwen3Asr: modelDir('qwen3'),
    paraformer: modelDir('paraformer')
  }
  const missing = Object.entries(dirs).filter(([kind, dir]) => {
    const id: AsrEngineId = kind === 'paraformer' ? 'paraformer' : 'qwen3'
    return !ASR_ENGINES[id].requiredPaths.every((rel) => existsSync(join(dir, rel)))
  })

  if (missing.length > 0) {
    finishProbe(TAG, cases, {
      skipped: `模型不全（${missing.map(([kind]) => kind).join(', ')}）：这台机器没装齐两台引擎，跑不了换引擎`
    })
    exitProbe(true, cases)
    return
  }

  const work = mkdtempSync(join(tmpdir(), 'omd2-asr-switch-'))
  const wav = clipPath(work)
  const worker = locateWorkerScript('asr-sherpa-worker.cjs')
  const node = voiceRuntimeNodeBinary()
  if (node === null) {
    finishProbe(TAG, cases, { skipped: '没有可用的 node 运行时（voice runtime 还没下载）' })
    exitProbe(true, cases)
    return
  }

  const lines: WorkerLine[] = []
  const child = spawn(node, [worker], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  const pending = new Map<string, (reply: Reply) => void>()
  let buffer = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk
    for (;;) {
      const index = buffer.indexOf('\n')
      if (index < 0) break
      const line = buffer.slice(0, index).trim()
      buffer = buffer.slice(index + 1)
      if (line === '') continue
      if (line.startsWith('{')) {
        const reply = JSON.parse(line) as Reply
        const resolve = pending.get(reply.id)
        if (resolve) {
          pending.delete(reply.id)
          resolve(reply)
        }
      } else {
        lines.push({ at: Date.now(), text: line })
      }
    }
  })

  let seq = 0
  const ask = (kind: string, hotwords = ''): Promise<{ reply: Reply; ms: number }> =>
    new Promise((resolve) => {
      const id = `${++seq}-${kind}`
      const started = Date.now()
      pending.set(id, (reply) => resolve({ reply, ms: Date.now() - started }))
      child.stdin.write(`${JSON.stringify({ id, kind, wav, dir: dirs[kind], hotwords })}\n`)
    })

  const events = (marker: string): { key?: string; resident?: number; loadMs?: number }[] =>
    lines
      .filter((line) => line.text.startsWith(marker))
      .map((line) => JSON.parse(line.text.slice(marker.length).trim()) as { key?: string; resident?: number; loadMs?: number })

  const first = await ask('paraformer')
  const again = await ask('paraformer')
  const switched = await ask('qwen3Asr')
  const back = await ask('paraformer')
  // 抓一份「只用两台引擎来回切」的账：后面的第三个键会故意换出一份新图，不能算进来。
  const loadsBeforeThirdKey = events('ASR_SHERPA_LOAD').length
  const hitsBeforeThirdKey = events('ASR_SHERPA_HIT').length
  // 第三个键（同一个引擎、不同热词）——上限 2，应该把最久没用到的那个挤出去。
  const third = await ask('paraformer', '冥魂大帝')
  const afterEvict = await ask('qwen3Asr')
  child.kill()
  rmSync(work, { recursive: true, force: true })

  const loads = events('ASR_SHERPA_LOAD')
  const hits = events('ASR_SHERPA_HIT')
  const evicts = events('ASR_SHERPA_EVICT')

  push('四次请求都有回答', [first, again, switched, back].every((r) => typeof r.reply.text === 'string'), first.reply.text)
  push('同一引擎第二次不重建（命中）', hits.length >= 1, `首次 ${first.ms} ms / 再次 ${again.ms} ms`)
  push(
    '换引擎各加载一次，来回切不再重建（两副图）',
    loadsBeforeThirdKey === 2 && hitsBeforeThirdKey === 2,
    `${describeLoads(loads.slice(0, loadsBeforeThirdKey))} · 命中 ${hitsBeforeThirdKey}`
  )
  push('切回原引擎不重建（命中，改前是 6.5 秒级）', back.ms < first.ms, `切回 ${back.ms} ms`)
  push(
    '第三个键挤掉的是最久没用到的那个（刚刚命中的那个不挤），常驻始终不超过两个',
    // 挤掉谁由 LRU 决定，不是「挤掉先来的那个」：上一步刚回来的 paraformer 是最近用过的，
    // 所以第三个键进来时该被挤掉的是 qwen3——这条断言钉的正是这个顺序。
    evicts.length >= 1 &&
      evicts.every((item) => (item.resident ?? 9) <= 2) &&
      (evicts[0]?.key ?? '').startsWith('qwen3Asr'),
    JSON.stringify(evicts)
  )
  push('挤掉之后仍能正常回答', typeof third.reply.text === 'string' && typeof afterEvict.reply.text === 'string', `${third.ms} ms / ${afterEvict.ms} ms`)

  finishProbe(TAG, cases, {
    firstLoadMs: loads[0]?.loadMs ?? null,
    responseMs: {
      firstParaformer: first.ms,
      paraformerAgain: again.ms,
      switchToQwen3: switched.ms,
      backToParaformer: back.ms,
      thirdKeyAfterEvict: third.ms,
      qwen3Again: afterEvict.ms
    },
    loads,
    hits,
    evicts
  })
  exitProbe(cases.every((item) => item.ok), cases)
}

function describeLoads(loads: { key?: string; loadMs?: number }[]): string {
  return loads.map((load) => `${load.key?.split('|')[0]}:${load.loadMs ?? '?'}ms`).join(' ')
}


