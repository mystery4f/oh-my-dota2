/**
 * #89：音色包的单文件导出与导入。
 *
 * 导出 = 把 refs.json 里的那一条 + 参考音频 + 两份权重打进一个 zip，并附一份清单。
 * 导入 = 先读清单核对每一件（`judgeVoicePackBundle`），通过了才落盘；不通过就一个字节都不写。
 * 读 zip 与写 zip 都复用 `services/zip.ts`（#111 起只有那一份实现），
 * refs.json 的读写复用 `sovits-refs.ts` 的那一对，路径校验复用 `isSafeRelPath`——
 * 包是别人给的，`../` 这类名字必须在落盘前就挡住。
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { buildZip, readZip } from '../zip'
import {
  VOICE_PACK_BUNDLE_VERSION,
  VOICE_PACK_MANIFEST_FILE,
  judgeVoicePackBundle,
  voicePackCheckLine,
  type VoicePackBundleManifest,
  type VoicePackPartError
} from '@shared/voice-pack-bundle'
import { isSafeRelPath, readRefsRaw, sovitsRefsRoot, sovitsWeightsRoot, writeRefsRaw } from './sovits-refs'

export interface VoicePackBundleExportResult {
  ok: boolean
  path: string | null
  files: string[]
  error: string | null
}

export interface VoicePackBundleImportResult {
  ok: boolean
  id: string | null
  files: string[]
  errors: VoicePackPartError[]
  /** 一句能贴给用户的话（成功与拒绝都有）。 */
  line: string
}

function refRows(refsRoot: string): Array<Record<string, unknown>> {
  return readRefsRaw(refsRoot).filter((row): row is Record<string, unknown> => typeof row === 'object' && row !== null && !Array.isArray(row))
}

function leaf(name: string): string {
  return name.split('/').pop() ?? name
}

/**
 * 导出一个音色包。`id` 就是参考音频子目录名（refs.json 里 `audio` 的第一段）。
 * 找不到那一条、或文件不在盘上，就返回 ok:false 并说清缺哪一件——绝不导出一个「看起来成功」的残包。
 */
export function exportVoicePackBundle(input: { id: string; userDataDir: string; dir?: string; at?: Date }): VoicePackBundleExportResult {
  const refsRoot = sovitsRefsRoot(input.userDataDir)
  const weightsRoot = sovitsWeightsRoot(input.userDataDir)
  const id = input.id.trim()
  const row = refRows(refsRoot).find((item) => String(item.audio ?? '').startsWith(`${id}/`))
  if (!row) return { ok: false, path: null, files: [], error: `refs.json 里没有音色「${id}」` }
  const audioRel = String(row.audio ?? '')
  const gpt = String(row.gptWeights ?? '')
  const sovits = String(row.sovitsWeights ?? '')
  // 路径来自 refs.json，是用户自己写过的值；仍然过一次同一套校验，避免把数据根外的文件打进包里。
  const unsafe = [
    isSafeRelPath(audioRel, { requireDir: true }) ? null : '参考音频',
    isSafeRelPath(gpt, { requireDir: true }) ? null : 'GPT 权重',
    isSafeRelPath(sovits, { requireDir: true }) ? null : 'SoVITS 权重'
  ].filter((item): item is string => item !== null)
  if (unsafe.length > 0) {
    return { ok: false, path: null, files: [], error: `refs.json 里这几项的路径不合规：${unsafe.join('、')}` }
  }
  const audioPath = join(refsRoot, audioRel)
  const missing = [
    existsSync(audioPath) ? null : '参考音频',
    existsSync(join(weightsRoot, gpt)) ? null : 'GPT 权重',
    existsSync(join(weightsRoot, sovits)) ? null : 'SoVITS 权重'
  ].filter((item): item is string => item !== null)
  if (missing.length > 0) {
    return { ok: false, path: null, files: [], error: `这个音色包缺 ${missing.join('、')}，先补上再导出` }
  }
  const manifest: VoicePackBundleManifest = {
    version: VOICE_PACK_BUNDLE_VERSION,
    id,
    name: String(row.name ?? id),
    promptText: String(row.promptText ?? ''),
    promptLang: row.promptLang === 'en' ? 'en' : 'zh',
    refAudio: leaf(audioRel),
    gptWeights: leaf(gpt),
    sovitsWeights: leaf(sovits),
    createdAt: (input.at ?? new Date()).toISOString()
  }
  const entries = [
    { name: VOICE_PACK_MANIFEST_FILE, data: Buffer.from(JSON.stringify(manifest, null, 2), 'utf8') },
    { name: manifest.refAudio, data: readFileSync(audioPath) },
    { name: manifest.gptWeights, data: readFileSync(join(weightsRoot, gpt)) },
    { name: manifest.sovitsWeights, data: readFileSync(join(weightsRoot, sovits)) }
  ]
  const dir = input.dir ?? join(input.userDataDir, 'export')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `voicepack-${id}.zip`)
  writeFileSync(path, buildZip(entries, input.at ?? new Date()))
  console.log('VOICE_PACK_EXPORT', JSON.stringify({ id, path, bytes: statSync(path).size, files: entries.length }))
  return { ok: true, path, files: entries.map((entry) => entry.name), error: null }
}

/**
 * 导入一个音色包。校验不过就返回错误清单（指名到件），不落任何文件。
 * `apply` 只在校验通过后调用一次，方便探针证明「拒绝 = 没有写」。
 */
export function importVoicePackBundle(input: {
  zipPath: string
  userDataDir: string
  apply?: (manifest: VoicePackBundleManifest, files: { refAudio: Buffer; gptWeights: Buffer; sovitsWeights: Buffer }) => void
}): VoicePackBundleImportResult {
  const entries = readZip(readFileSync(input.zipPath))
  if (entries === null) {
    console.log('VOICE_PACK_IMPORT_REJECT', JSON.stringify({ zip: input.zipPath, part: 'manifest', reason: '不是可读的 zip' }))
    return {
      ok: false,
      id: null,
      files: [],
      errors: [{ part: 'manifest', detail: '这个文件不是可读的 zip' }],
      line: '这个包不能用 —— 它不是一个完整的 zip 文件'
    }
  }
  const names = [...entries.keys()].filter((name) => name !== VOICE_PACK_MANIFEST_FILE)
  let manifest: unknown = null
  const raw = entries.get(VOICE_PACK_MANIFEST_FILE)
  if (raw) {
    try {
      manifest = JSON.parse(Buffer.from(raw).toString('utf8'))
    } catch {
      manifest = null
    }
  }
  const check = judgeVoicePackBundle({ manifest: manifest, names })
  if (!check.ok) {
    console.log('VOICE_PACK_IMPORT_REJECT', JSON.stringify({ zip: input.zipPath, errors: check.errors }))
    return { ok: false, id: null, files: [], errors: check.errors, line: voicePackCheckLine(check) }
  }
  const good = manifest as VoicePackBundleManifest
  // 清单说「有这一件」还不够：名字本身必须是不带 ../、不带盘符的相对文件名。
  const unsafe = (['refAudio', 'gptWeights', 'sovitsWeights'] as const).filter((part) => !isSafeRelPath(good[part], { maxLength: 160 }))
  if (unsafe.length > 0) {
    const errors: VoicePackPartError[] = unsafe.map((part) => ({ part, detail: `清单里的路径「${String(good[part])}」越出了音色目录` }))
    console.log('VOICE_PACK_IMPORT_REJECT', JSON.stringify({ zip: input.zipPath, errors }))
    return { ok: false, id: null, files: [], errors, line: voicePackCheckLine({ ok: false, errors }) }
  }
  const files = {
    refAudio: Buffer.from(entries.get(good.refAudio) ?? Buffer.alloc(0)),
    gptWeights: Buffer.from(entries.get(good.gptWeights) ?? Buffer.alloc(0)),
    sovitsWeights: Buffer.from(entries.get(good.sovitsWeights) ?? Buffer.alloc(0))
  }
  if (input.apply) {
    input.apply(good, files)
  } else {
    const refsRoot = sovitsRefsRoot(input.userDataDir)
    const weightsRoot = sovitsWeightsRoot(input.userDataDir)
    const audioRel = `${good.id}/${good.refAudio}`
    const gptRel = `${good.id}/${good.gptWeights}`
    const sovitsRel = `${good.id}/${good.sovitsWeights}`
    for (const [path, data] of [
      [join(refsRoot, audioRel), files.refAudio],
      [join(weightsRoot, gptRel), files.gptWeights],
      [join(weightsRoot, sovitsRel), files.sovitsWeights]
    ] as Array<[string, Buffer]>) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, data)
    }
    const rows = refRows(refsRoot).filter((row) => !String(row.audio ?? '').startsWith(`${good.id}/`))
    rows.push({
      name: good.name,
      audio: audioRel,
      promptText: good.promptText,
      promptLang: good.promptLang,
      gptWeights: gptRel,
      sovitsWeights: sovitsRel
    })
    writeRefsRaw(refsRoot, rows)
  }
  console.log('VOICE_PACK_IMPORT', JSON.stringify({ id: good.id, files: 3, zip: input.zipPath }))
  return {
    ok: true,
    id: good.id,
    files: [good.refAudio, good.gptWeights, good.sovitsWeights],
    errors: [],
    line: voicePackCheckLine(check)
  }
}