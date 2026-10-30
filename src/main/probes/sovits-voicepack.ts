import { app } from 'electron'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { applySovitsVoice } from '../services/voice/sovits-server'
import {
  cleanupStalePackFiles,
  downloadPackFile,
  mergeRefsJson,
  mergeVoicePacks,
  packRefsMerge,
  parseVoicePackManifest,
  planVoicePackFiles,
  resolveVoicePacks,
  safePackRelPath,
  VOICE_PACKS,
  voicePackInstalled
} from '../services/voice/sovits-voicepack'

/**
 * 音色包探针（--sovits-voicepack-probe）：refs 合并、安装判定、断点续传、切权重时序。
 * 不碰真实数据根、不碰 modelscope、不需要 13GB 引擎——下载走本地 HTTP 假源，
 * 切权重走本地假 api_v2，验证的正是发出去的请求顺序与参数。
 */
export async function runSovitsVoicepackProbe(): Promise<void> {
  const base = mkdtempSync(join(tmpdir(), 'oh-my-dota2-sovits-voicepack-'))
  const checks: { name: string; ok: boolean; detail?: string }[] = []
  const push = (name: string, ok: boolean, detail?: string): void => {
    checks.push({ name, ok, detail })
  }
  try {
    const pack = VOICE_PACKS[0]
    const refsRoot = join(base, 'refs')
    const weightsRoot = join(base, 'weights')
    mkdirSync(refsRoot, { recursive: true })
    mkdirSync(weightsRoot, { recursive: true })

    // —— 纯函数：下载计划 ——
    const plan = planVoicePackFiles(pack, refsRoot, weightsRoot)
    push('计划含三件套（参考+GPT+SoVITS）', plan.length === 3, `${plan.length} 个文件`)
    push(
      '参考落 refs 根、权重落权重根',
      plan[0].dest.startsWith(refsRoot) && plan[1].dest.startsWith(weightsRoot) && plan[2].dest.startsWith(weightsRoot),
      plan.map((file) => file.dest).join('|')
    )

    // —— 纯函数：安装判定（精确字节） ——
    push('没下文件不算安装', !voicePackInstalled(pack, refsRoot, weightsRoot))
    for (const file of plan) {
      mkdirSync(join(file.dest, '..'), { recursive: true })
      writeFileSync(file.dest, Buffer.alloc(file.bytes, 1))
    }
    push('三件套字节齐了算安装', voicePackInstalled(pack, refsRoot, weightsRoot))
    writeFileSync(plan[1].dest, Buffer.alloc(plan[1].bytes - 1, 1))
    push('少一个字节都不算（防半截文件）', !voicePackInstalled(pack, refsRoot, weightsRoot))
    writeFileSync(plan[1].dest, Buffer.alloc(plan[1].bytes, 1))

    // —— 纯函数：refs.json 合并 ——
    const entryA = { name: '甲', audio: 'a/a.mp3', promptText: 'x', promptLang: 'zh' }
    const entryB = { name: '乙', audio: 'b/b.mp3', promptText: 'y', promptLang: 'zh' }
    push('空库合并成单条', mergeRefsJson([], entryA).length === 1)
    const merged = mergeRefsJson([entryA, entryB], { ...entryB, promptText: 'y2' })
    push('同 audio 键原位替换不追加', merged.length === 2 && (merged[1] as { promptText: string }).promptText === 'y2')
    const fromObject = mergeRefsJson({ not: 'array' }, entryA)
    push('坏索引按空表起步', Array.isArray(fromObject) && fromObject.length === 1)

    // —— 纯函数：远端清单 voicepacks.json 解析 ——
    const manifestOk = {
      schemaVersion: 1,
      packs: [
        {
          id: 'windranger', name: '风行者', version: 'e30', note: '重训版', default: true,
          promptText: '谁能预测到这一幕？哦，等一下。是我。', promptLang: 'zh',
          refAudio: { path: 'windranger/windranger-arcana-ref-zh.wav', bytes: 284_666 },
          gptWeights: { path: 'windranger/windranger-e30.ckpt', bytes: 155_312_333 },
          sovitsWeights: { path: 'windranger/windranger_e8_s384.pth', bytes: 85_007_488 }
        },
        { id: 'new-hero', name: '新英雄', version: 'e1', promptText: 'hi', promptLang: 'zh',
          refAudio: { path: 'new-hero/ref.wav', bytes: 1 }, gptWeights: { path: 'new-hero/g.ckpt', bytes: 2 }, sovitsWeights: { path: 'new-hero/s.pth', bytes: 3 } }
      ]
    }
    const parsed = parseVoicePackManifest(manifestOk)
    push('合法清单解析出两个包', parsed !== null && parsed.length === 2, parsed ? `${parsed.length}` : 'null')
    push('version 与 URL 透传', parsed !== null && parsed[0].version === 'e30' && parsed[0].gptWeights.url.includes('windranger-e30.ckpt'))
    push('note 缺省成空串', parsed !== null && parsed[1].note === '')
    push('schemaVersion 不认直接废', parseVoicePackManifest({ ...manifestOk, schemaVersion: 2 }) === null)
    push('packs 非数组直接废', parseVoicePackManifest({ schemaVersion: 1, packs: 'nope' }) === null)
    push('空包列表当失败走兜底', parseVoicePackManifest({ schemaVersion: 1, packs: [] }) === null)
    const evilPath = parseVoicePackManifest({ schemaVersion: 1, packs: [{ ...manifestOk.packs[0], gptWeights: { path: '../evil.ckpt', bytes: 1 } }] })
    push('越权路径的包整条剔除', evilPath === null)
    const badBytes = parseVoicePackManifest({ schemaVersion: 1, packs: [
      manifestOk.packs[1],
      { ...manifestOk.packs[0], refAudio: { path: 'windranger/r.wav', bytes: 1.5 } }
    ] })
    push('字节数非整数剔除坏包留好包', badBytes !== null && badBytes.length === 1 && badBytes[0].id === 'new-hero')
    push('反斜杠路径不安全', !safePackRelPath('a\\b.wav'))
    push('绝对路径不安全', !safePackRelPath('/etc/passwd') && !safePackRelPath('C:/x.wav'))
    push('无子目录不安全（必须 a/b 起）', !safePackRelPath('plain.wav'))
    push('正常两段路径安全', safePackRelPath('windranger/r.wav'))

    // —— 纯函数：远端与内置目录合并 ——
    const builtinDefaultId = VOICE_PACKS.find((item) => item.default)?.id ?? ''
    const mergedPacks = mergeVoicePacks(parsed, VOICE_PACKS)
    push('远端同 id 覆盖内置', mergedPacks.find((item) => item.id === 'windranger')?.version === 'e30')
    push('内置独有包保留', mergedPacks.some((item) => item.id === 'mirana'))
    push('远端新增包进目录', mergedPacks.some((item) => item.id === 'new-hero'))
    push('远端为空整份用内置', mergeVoicePacks(null, VOICE_PACKS).length === VOICE_PACKS.length)
    const noDefault = [{ ...VOICE_PACKS[1], default: false }, { ...VOICE_PACKS[0], default: false }]
    const keptDefault = mergeVoicePacks(noDefault, VOICE_PACKS)
    push('没人当默认时保住内置默认包', keptDefault.find((item) => item.id === builtinDefaultId)?.default === true)

    // —— 纯函数：包条目合并（同名/同音频去重）与孤儿清理 ——
    const oldRefs = [
      { name: '风行者', audio: 'windranger/old-ref.wav', promptText: '旧', promptLang: 'zh', gptWeights: 'windranger/old.ckpt', sovitsWeights: 'windranger/old.pth' },
      { name: '别的', audio: 'other/keep.wav', promptText: '留', promptLang: 'zh' }
    ]
    const packMerged = packRefsMerge(oldRefs, VOICE_PACKS[0])
    push('同名旧条目剔掉且报出旧音频', packMerged.list.length === 2 && packMerged.staleAudio.includes('windranger/old-ref.wav'))
    push('新条目带权重路径落位', (packMerged.list.at(-1) as { gptWeights?: string }).gptWeights === VOICE_PACKS[0].gptWeights.relPath)
    const sameAudioMerged = packRefsMerge([{ name: '别名', audio: VOICE_PACKS[0].refAudio.relPath, promptText: 'x', promptLang: 'zh' }], VOICE_PACKS[0])
    push('同音频不同名也替换', sameAudioMerged.list.length === 1 && sameAudioMerged.staleAudio.length === 0)

    const packV2 = { ...VOICE_PACKS[0], gptWeights: { ...VOICE_PACKS[0].gptWeights, relPath: 'windranger/windranger-e30.ckpt' } }
    const wDir = join(weightsRoot, 'windranger')
    mkdirSync(wDir, { recursive: true })
    writeFileSync(join(wDir, 'windranger-e30.ckpt'), Buffer.alloc(4, 1))
    writeFileSync(join(wDir, VOICE_PACKS[0].sovitsWeights.relPath.split('/').pop() ?? ''), Buffer.alloc(4, 1))
    writeFileSync(join(wDir, 'windranger-e15.ckpt.part'), Buffer.alloc(4, 1))
    const cleaned = cleanupStalePackFiles(packV2, ['windranger/old-ref.wav', 'other/keep.wav'], refsRoot, weightsRoot)
    push(
      '换版清理只删旧权重与旧参考',
      cleaned.includes('weights/windranger/windranger-e15.ckpt.part') && !cleaned.some((f) => f.includes('windranger_e8_s192.pth')) && !cleaned.includes('other/keep.wav'),
      cleaned.join('|')
    )
    // —— 集成：远端清单经本地 HTTP 生效（resolveVoicePacks 可注入 URL） ——
    const manifestServer = await startHttpServer((req, reply) => {
      if (req.url === '/voicepacks.json') reply(Buffer.from(JSON.stringify(manifestOk)), 200, { 'content-type': 'application/json' })
      else reply(Buffer.from('nope'), 404)
    })
    try {
      const fromHttp = await resolveVoicePacks({ url: `http://127.0.0.1:${manifestServer.port}/voicepacks.json` })
      push('远端清单优先于内置', fromHttp.find((item) => item.id === 'windranger')?.version === 'e30' && fromHttp.some((item) => item.id === 'new-hero'))
      const fallbackPacks = await resolveVoicePacks({ url: `http://127.0.0.1:${manifestServer.port}/missing.json` })
      push(
        '清单 404 落回内置兜底',
        fallbackPacks.length === VOICE_PACKS.length && fallbackPacks.find((item) => item.id === 'windranger')?.version === 'e15',
        fallbackPacks.map((item) => `${item.id}:${item.version}`).join('|')
      )
    } finally {
      manifestServer.close()
    }

    // —— 集成：本地 HTTP 断点续传 ——
    const payload = Buffer.from('0123456789abcdefghijklmnopqrstuvwxyz')
    const seenRanges: string[] = []
    const fileServer = await startHttpServer((req, reply) => {
      const range = typeof req.headers.range === 'string' ? req.headers.range : ''
      seenRanges.push(range ?? '')
      if (range && range.startsWith('bytes=')) {
        const offset = Number(range.slice(6, -1))
        // 206 必须带 content-range，downloadPackFile 靠它确认总量对得上才肯续传。
        reply(payload.subarray(offset), 206, { 'content-range': `bytes ${offset}-${payload.length - 1}/${payload.length}` })
      } else {
        reply(payload)
      }
    })
    try {
      const full = join(base, 'full.bin')
      await downloadPackFile(`http://127.0.0.1:${fileServer.port}/f.bin`, full, payload.length, () => {})
      push('全新下载落到目标且字节一致', statSync(full).size === payload.length && readFileSync(full).equals(payload))
      push('无 .part 时不带 Range', seenRanges[seenRanges.length - 1] === '')

      // 半截 .part：先写前 10 个字节，续传必须从 10 接着拿。
      const resumed = join(base, 'resumed.bin')
      writeFileSync(`${resumed}.part`, payload.subarray(0, 10))
      await downloadPackFile(`http://127.0.0.1:${fileServer.port}/r.bin`, resumed, payload.length, () => {})
      push('断点续传续上了后半截', readFileSync(resumed).equals(payload), `Range=${seenRanges[seenRanges.length - 1]}`)
      push('续传请求带 bytes=10- Range', seenRanges[seenRanges.length - 1] === 'bytes=10-')

      let mismatch = ''
      try {
        await downloadPackFile(`http://127.0.0.1:${fileServer.port}/bad.bin`, join(base, 'bad.bin'), payload.length + 5, () => {})
      } catch (err) {
        mismatch = err instanceof Error ? err.message : String(err)
      }
      push('字节数对不上要抛错', mismatch.includes('size mismatch'), mismatch)
    } finally {
      fileServer.close()
    }

    // —— 集成：假 api_v2，验切权重顺序与幂等 ——
    const calls: string[] = []
    const apiServer = await startHttpServer((req, reply) => {
      calls.push(req.url ?? '')
      reply(Buffer.from('{}'))
    })
    try {
      const ok = await applySovitsVoice(apiServer.port, {
        gptWeightsPath: join(weightsRoot, 'windranger', 'gpt.ckpt'),
        sovitsWeightsPath: join(weightsRoot, 'windranger', 'sovits.pth')
      })
      push('切权重先 GPT 后 SoVITS', ok && calls[0].startsWith('/set_gpt_weights?') && calls[1].startsWith('/set_sovits_weights?'), calls.join('|'))
      push(
        '权重走绝对路径参数',
        calls[0].includes(encodeURIComponent(join(weightsRoot, 'windranger', 'gpt.ckpt'))),
        calls[0]
      )
      const countBefore = calls.length
      await applySovitsVoice(apiServer.port, {
        gptWeightsPath: join(weightsRoot, 'windranger', 'gpt.ckpt'),
        sovitsWeightsPath: join(weightsRoot, 'windranger', 'sovits.pth')
      })
      push('同一音色重复切换被幂等跳过', calls.length === countBefore, `${countBefore}→${calls.length}`)
      await applySovitsVoice(apiServer.port, {
        gptWeightsPath: join(weightsRoot, 'mirana', 'gpt.ckpt'),
        sovitsWeightsPath: join(weightsRoot, 'mirana', 'sovits.pth')
      })
      push('换音色重新切一遍', calls.length === countBefore + 2, `${countBefore}→${calls.length}`)
      const cleared = await applySovitsVoice(apiServer.port, null)
      push('零样本条目不发权重请求', cleared && calls.length === countBefore + 2)
    } finally {
      apiServer.close()
    }
  } finally {
    rmSync(base, { recursive: true, force: true })
  }

  const failed = checks.filter((item) => !item.ok)
  console.log(
    'SOVITS_VOICEPACK_PROBE',
    JSON.stringify({ ok: failed.length === 0, passed: checks.length - failed.length, failed: failed.length })
  )
  for (const item of checks) {
    console.log(`  ${item.ok ? 'ok  ' : 'FAIL'} ${item.name}${item.detail ? `  (${item.detail})` : ''}`)
  }
  app.exit(failed.length === 0 ? 0 : 1)
}

function startHttpServer(
  onRequest: (
    req: { url: string; headers: Record<string, string | string[] | undefined> },
    reply: (body: Buffer, status?: number, headers?: Record<string, string>) => void
  ) => void
): Promise<Server & { port: number }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      onRequest(
        { url: req.url ?? '/', headers: req.headers as Record<string, string | string[] | undefined> },
        (body, status = 200, headers = {}) => {
          res.writeHead(status, { 'content-type': 'application/octet-stream', ...headers })
          res.end(body)
        }
      )
    })
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      const port = typeof address === 'object' && address !== null ? address.port : 0
      resolve(Object.assign(server, { port }))
    })
  })
}
