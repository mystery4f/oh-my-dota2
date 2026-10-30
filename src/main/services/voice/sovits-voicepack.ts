import { app } from 'electron'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { SOVITS_SEED_REF_DIR, type SovitsVoicePack } from '@shared/ipc'
import { loadSettings } from '../settings'
import { listSovitsRefs, sovitsRefsRoot, sovitsWeightsRoot } from './sovits-refs'
import { activateSovitsRef, recordSovitsLog } from './sovits-server'
import { synthesizeEdge } from './edge'
import { DEFAULT_EDGE_VOICE } from '@shared/tts-voices'

/**
 * 英雄音色包：参考音频 + 成对的微调权重，从魔搭公开仓一键拉齐。
 *
 * 权重文件（每个约 230MB）不进 GitHub Release——仓库已 460MB 且国内拉不动，
 * 魔搭直连满速；引擎包同理走魔搭。训练产物只此一个分发源，URL 全在下面的目录里。
 *
 * 落位（全部在数据根，重装引擎包不冲掉）：
 *   - 参考音频 → tts/sovits-refs/<id>/<原名>，refs.json 由这里代写（用户仍可手编）
 *   - 微调权重 → gpt-sovits/weights/<id>/<原名>，条目里的 gptWeights/sovitsWeights 相对这一层
 */

/** 魔搭仓：用户手工建仓上传，文件名与 D:\AI 训练产物一致，上传清单见 .tmp/sovits-plan.md。 */
const VOICEPACK_REPO = 'a1078185271/oh-my-dota2-voicepacks'

export interface VoicePackFileDef {
  url: string
  /** 相对落位路径（POSIX）：参考音频相对 refs 根，权重相对 weights 根。 */
  relPath: string
  bytes: number
}

export interface VoicePackDef {
  id: string
  name: string
  /** 训练轮次标识（e15 = GPT 第 15 轮）。文件名本身就带版本，这里只是给面板看的短号。 */
  version: string
  note: string
  default: boolean
  promptText: string
  promptLang: 'zh' | 'en'
  refAudio: VoicePackFileDef
  gptWeights: VoicePackFileDef
  sovitsWeights: VoicePackFileDef
}

function modelscopeUrl(path: string): string {
  return `https://www.modelscope.cn/models/${VOICEPACK_REPO}/resolve/master/${path}`
}

/** 内置目录：两个英雄音色 = 训练对（ckpt + pth 成对切），字节数取自训练产物实测。 */
export const VOICE_PACKS: VoicePackDef[] = [
  {
    id: 'windranger',
    name: '风行者',
    version: 'e15',
    note: '默认音色，引擎装完自动下载（约 230MB）',
    default: true,
    promptText: '谁能预测到这一幕？哦，等一下。是我。',
    promptLang: 'zh',
    refAudio: { url: modelscopeUrl('windranger/windranger-arcana-ref-zh.wav'), relPath: 'windranger/windranger-arcana-ref-zh.wav', bytes: 284_666 },
    gptWeights: { url: modelscopeUrl('windranger/windranger-e15.ckpt'), relPath: 'windranger/windranger-e15.ckpt', bytes: 155_312_333 },
    sovitsWeights: { url: modelscopeUrl('windranger/windranger_e8_s192.pth'), relPath: 'windranger/windranger_e8_s192.pth', bytes: 85_007_488 }
  },
  {
    id: 'mirana',
    name: '米拉娜',
    version: 'e15',
    note: '月之公主，与风行者同批训练（约 230MB）',
    default: false,
    promptText: '从银夜森林到太阳帝权人们都是怀着敬畏和尊重说出我的名字',
    promptLang: 'zh',
    refAudio: { url: modelscopeUrl('mirana/mira_per_spawn_13.mp3'), relPath: 'mirana/mira_per_spawn_13.mp3', bytes: 73_551 },
    gptWeights: { url: modelscopeUrl('mirana/mirana-e15.ckpt'), relPath: 'mirana/mirana-e15.ckpt', bytes: 155_312_566 },
    sovitsWeights: { url: modelscopeUrl('mirana/mirana_e8_s336.pth'), relPath: 'mirana/mirana_e8_s336.pth', bytes: 85_006_749 }
  }
]

/** 清单里的相对路径规则（与 sovits-refs 的 parseEntry 同款）：POSIX、不绝对、无 ..，必须 a/b 两段起。 */
export function safePackRelPath(p: unknown): p is string {
  return (
    typeof p === 'string' &&
    p.length > 3 &&
    p.length <= 200 &&
    !p.includes('\\') &&
    !p.includes(':') &&
    !p.startsWith('/') &&
    p.split('/').every((seg) => seg.length > 0 && seg !== '.' && seg !== '..') &&
    p.includes('/')
  )
}

interface ManifestFileRaw {
  path: unknown
  bytes: unknown
}

function parseManifestFile(raw: unknown): VoicePackFileDef | null {
  if (typeof raw !== 'object' || raw === null) return null
  const { path, bytes } = raw as ManifestFileRaw
  if (!safePackRelPath(path)) return null
  if (!Number.isInteger(bytes) || (bytes as number) <= 0 || (bytes as number) > 20 * 1024 ** 3) return null
  return { url: modelscopeUrl(path), relPath: path, bytes: bytes as number }
}

/**
 * 远端 voicepacks.json → 包目录。严格校验：schemaVersion 必须是 1，单个包坏就丢这个包
 * （别让一条坏数据废掉整份清单），一条都不剩才算失败（返回 null，走内置兜底）。
 */
export function parseVoicePackManifest(raw: unknown): VoicePackDef[] | null {
  if (typeof raw !== 'object' || raw === null) return null
  const top = raw as { schemaVersion?: unknown; packs?: unknown }
  if (top.schemaVersion !== 1 || !Array.isArray(top.packs)) return null
  const packs: VoicePackDef[] = []
  for (const item of top.packs) {
    if (typeof item !== 'object' || item === null) continue
    const p = item as Record<string, unknown>
    if (typeof p.id !== 'string' || !/^[a-z0-9][a-z0-9_-]*$/.test(p.id)) continue
    if (typeof p.name !== 'string' || p.name.length === 0 || p.name.length > 40) continue
    if (typeof p.version !== 'string' || p.version.length === 0 || p.version.length > 32) continue
    if (typeof p.promptText !== 'string' || p.promptText.length === 0 || p.promptText.length > 500) continue
    if (p.promptLang !== 'zh' && p.promptLang !== 'en') continue
    const refAudio = parseManifestFile(p.refAudio)
    const gptWeights = parseManifestFile(p.gptWeights)
    const sovitsWeights = parseManifestFile(p.sovitsWeights)
    if (!refAudio || !gptWeights || !sovitsWeights) continue
    packs.push({
      id: p.id,
      name: p.name,
      version: p.version,
      note: typeof p.note === 'string' ? p.note.slice(0, 120) : '',
      default: p.default === true,
      promptText: p.promptText,
      promptLang: p.promptLang,
      refAudio,
      gptWeights,
      sovitsWeights
    })
  }
  return packs.length > 0 ? packs : null
}

/** 远端目录与内置目录按 id 合并：远端赢（同 id 覆盖），内置独有的补在后面；没人当默认时保住内置默认包。 */
export function mergeVoicePacks(remote: VoicePackDef[] | null, builtin: VoicePackDef[]): VoicePackDef[] {
  if (!remote) return builtin
  const byId = new Map(builtin.map((pack) => [pack.id, { ...pack }]))
  for (const pack of remote) byId.set(pack.id, pack)
  const merged = [...byId.values()]
  if (!merged.some((pack) => pack.default)) {
    const builtinDefault = merged.find((pack) => pack.id === builtin.find((b) => b.default)?.id)
    if (builtinDefault) builtinDefault.default = true
    else if (merged.length > 0) merged[0].default = true
  }
  return merged
}

const MANIFEST_URL = modelscopeUrl('voicepacks.json')
const MANIFEST_TTL_MS = 5 * 60_000
let manifestCache: { at: number; remote: VoicePackDef[] | null } | null = null

/** 拉一份远端清单（URL 可注入，探针用本地假源）。任何失败都返回 null，绝不抛。 */
export async function fetchVoicePackManifest(url = MANIFEST_URL): Promise<VoicePackDef[] | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(10_000) })
    if (!response.ok) return null
    return parseVoicePackManifest(await response.json())
  } catch {
    return null
  }
}

/**
 * 面板/安装/自动装共用的目录来源：远端清单优先（5 分钟缓存），拉不到用内置兜底。
 * force 跳缓存重拉；带 url 时直连该源不落缓存（探针专用）。
 */
export async function resolveVoicePacks(opts?: { force?: boolean; url?: string }): Promise<VoicePackDef[]> {
  if (opts?.url) return mergeVoicePacks(await fetchVoicePackManifest(opts.url), VOICE_PACKS)
  if (!opts?.force && manifestCache && Date.now() - manifestCache.at < MANIFEST_TTL_MS) {
    return mergeVoicePacks(manifestCache.remote, VOICE_PACKS)
  }
  const remote = await fetchVoicePackManifest()
  // 拉挂了就继续用手里的旧缓存（哪怕是过期的），比把用户打回内置版强；从没拉到过才落兜底。
  if (remote) manifestCache = { at: Date.now(), remote }
  return mergeVoicePacks(manifestCache?.remote ?? null, VOICE_PACKS)
}

/** refs.json 落包条目（纯函数）：同名（包拥有自己的名字）或同音频路径的旧条目先剔掉，顺带报出可删的旧音频。 */
export function packRefsMerge(
  current: unknown,
  pack: VoicePackDef
): { list: unknown[]; staleAudio: string[] } {
  const list = Array.isArray(current) ? [...current] : []
  const keep: unknown[] = []
  const staleAudio: string[] = []
  for (const item of list) {
    if (typeof item === 'object' && item !== null) {
      const entry = item as Record<string, unknown>
      const sameName = entry.name === pack.name
      const sameAudio = entry.audio === pack.refAudio.relPath
      if (sameName || sameAudio) {
        if (typeof entry.audio === 'string' && entry.audio !== pack.refAudio.relPath) staleAudio.push(entry.audio)
        continue
      }
    }
    keep.push(item)
  }
  keep.push(refsEntryFor(pack))
  return { list: keep, staleAudio }
}

/** 换版后的孤儿清理：权重目录里不属于当前版本的文件全删；旧参考音频只删本包目录下的。 */
export function cleanupStalePackFiles(pack: VoicePackDef, staleAudio: string[], refsRoot: string, weightsRoot: string): string[] {
  const deleted: string[] = []
  const weightsDir = join(weightsRoot, pack.id)
  const keepNames = new Set([pack.gptWeights.relPath, pack.sovitsWeights.relPath].map((rel) => rel.split('/').pop() ?? ''))
  try {
    for (const name of readdirSync(weightsDir)) {
      const clean = name.replace(/\.part$/, '')
      if (!keepNames.has(clean)) {
        rmSync(join(weightsDir, name), { force: true })
        deleted.push(`weights/${pack.id}/${name}`)
      }
    }
  } catch {
    // 目录不在 = 没有孤儿，安静通过。
  }
  for (const rel of staleAudio) {
    const segments = rel.split('/')
    if (segments[0] !== pack.id || segments.length < 2) continue // 只动本包目录，用户的参考不碰
    const target = join(refsRoot, ...segments)
    try {
      rmSync(target, { force: true })
      deleted.push(rel)
    } catch {
      // 删不掉就留着，下次清理还会撞见。
    }
  }
  return deleted
}

/** 删除音色包：三件套 + refs.json 条目 + 下载进度一起清；正在使用的包直接拒绝。 */
export async function deleteVoicePack(id: string): Promise<SovitsVoicePack[]> {
  const pack = (await resolveVoicePacks()).find((item) => item.id === id)
  if (!pack) throw new Error(`unknown voicepack: ${id}`)
  const refsRoot = sovitsRefsRoot(app.getPath('userData'))
  const weightsRoot = sovitsWeightsRoot(app.getPath('userData'))
  const refPath = join(refsRoot, ...pack.refAudio.relPath.split('/'))
  const settings = loadSettings()
  const active = settings.ttsSovitsRefAudio.trim().toLowerCase() === refPath.toLowerCase()
  if (active) throw new Error('正在使用这个音色，先切到其他音色再删除')
  rmSync(refPath, { force: true })
  rmSync(`${refPath}.part`, { force: true })
  rmSync(join(weightsRoot, pack.id), { recursive: true, force: true })
  const refsFile = join(refsRoot, 'refs.json')
  if (existsSync(refsFile)) {
    let current: unknown = []
    try {
      current = JSON.parse(readFileSync(refsFile, 'utf-8'))
    } catch {
      current = []
    }
    const kept = (Array.isArray(current) ? current : []).filter(
      (item) => !(typeof item === 'object' && item !== null && ((item as Record<string, unknown>).name === pack.name || (item as Record<string, unknown>).audio === pack.refAudio.relPath))
    )
    writeFileSync(refsFile, `${JSON.stringify(kept, null, 2)}\n`, 'utf-8')
  }
  packRuns.delete(pack.id)
  recordSovitsLog('TTS_SOVITS_PACK_DELETE', { id: pack.id })
  return sovitsVoicePacks()
}

/** 下载计划（纯函数，探针用）：每个文件落到哪、已在盘上多少字节、还差多少。 */
export function planVoicePackFiles(pack: VoicePackDef, refsRoot: string, weightsRoot: string): Array<{
  url: string
  dest: string
  bytes: number
  have: number
}> {
  const dest = (base: string, file: VoicePackFileDef) => join(base, ...file.relPath.split('/'))
  return [pack.refAudio, pack.gptWeights, pack.sovitsWeights].map((file) => {
    const target = file === pack.refAudio ? dest(refsRoot, file) : dest(weightsRoot, file)
    let have = 0
    try {
      have = existsSync(target) ? statSync(target).size : existsSync(`${target}.part`) ? statSync(`${target}.part`).size : 0
    } catch {
      have = 0
    }
    return { url: file.url, dest: target, bytes: file.bytes, have }
  })
}

/** 音色包是否已齐（三个文件都在且字节数对上——半截的 .part 不算）。 */
export function voicePackInstalled(pack: VoicePackDef, refsRoot: string, weightsRoot: string): boolean {
  return planVoicePackFiles(pack, refsRoot, weightsRoot).every((file) => {
    try {
      return existsSync(file.dest) && statSync(file.dest).size === file.bytes
    } catch {
      return false
    }
  })
}

/**
 * refs.json 合并（纯函数，探针用）：按 audio 键 upsert——同路径的旧条目整条替换
 * （音色包升级后转写/权重可能都变了），别人的条目原样保留，顺序稳定（追加在尾部）。
 */
export function mergeRefsJson(current: unknown, entry: Record<string, unknown>): unknown[] {
  const list = Array.isArray(current) ? [...current] : []
  const index = list.findIndex(
    (item) => typeof item === 'object' && item !== null && (item as Record<string, unknown>).audio === entry.audio
  )
  if (index >= 0) list.splice(index, 1)
  list.push(entry)
  return list
}

/** refs.json 里音色包对应的那条手写形状（字段名与手编文件完全一致）。 */
function refsEntryFor(pack: VoicePackDef): Record<string, unknown> {
  return {
    name: pack.name,
    audio: pack.refAudio.relPath,
    promptText: pack.promptText,
    promptLang: pack.promptLang,
    gptWeights: pack.gptWeights.relPath,
    sovitsWeights: pack.sovitsWeights.relPath
  }
}

const packRuns = new Map<string, { downloading: boolean; progress: number; error: string | null }>()

/** 面板视图：目录 + 本地状态（在不在、下没下、进度、错误）合成一张表。 */
export async function sovitsVoicePacks(): Promise<SovitsVoicePack[]> {
  const refsRoot = sovitsRefsRoot(app.getPath('userData'))
  const weightsRoot = sovitsWeightsRoot(app.getPath('userData'))
  const activeRef = loadSettings().ttsSovitsRefAudio.trim().toLowerCase()
  const packs = await resolveVoicePacks()
  return packs.map((pack) => {
    const run = packRuns.get(pack.id)
    const plan = planVoicePackFiles(pack, refsRoot, weightsRoot)
    const haveBytes = plan.reduce((sum, file) => sum + Math.min(file.have, file.bytes), 0)
    return {
      id: pack.id,
      name: pack.name,
      version: pack.version,
      note: pack.note,
      defaultPack: pack.default,
      bytes: plan.reduce((sum, file) => sum + file.bytes, 0),
      haveBytes,
      installed: voicePackInstalled(pack, refsRoot, weightsRoot),
      downloading: run?.downloading ?? false,
      progress: run?.progress ?? 0,
      active: activeRef !== '' && activeRef === join(refsRoot, ...pack.refAudio.relPath.split('/')).toLowerCase(),
      error: run?.error ?? null
    }
  })
}

/** 小文件断点续传下载：.part 在就带 Range 接着下（魔搭 206），完事原子改名。 */
export async function downloadPackFile(
  url: string,
  dest: string,
  expectedBytes: number,
  onProgress: (done: number) => void
): Promise<void> {
  mkdirSync(join(dest, '..'), { recursive: true })
  const part = `${dest}.part`
  const partBytes = existsSync(part) ? statSync(part).size : 0
  if (existsSync(dest) && statSync(dest).size === expectedBytes) return
  const response = await fetch(url, partBytes > 0 ? { headers: { Range: `bytes=${partBytes}-` } } : undefined)
  if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`)
  const rangeTotal = response.status === 206 ? Number((response.headers.get('content-range') ?? '').split('/')[1]) : 0
  const appendable = response.status === 206 && rangeTotal === expectedBytes
  if (!appendable && partBytes > 0) {
    recordSovitsLog('TTS_SOVITS_PACK_RESTART', { url, partBytes, status: response.status })
  }
  let done = appendable ? partBytes : 0
  const source = Readable.fromWeb(response.body as never)
  source.on('data', (chunk: Buffer) => {
    done += chunk.length
    onProgress(done)
  })
  await pipeline(source, createWriteStream(part, { flags: appendable ? 'a' : 'w' }))
  if (done !== expectedBytes) throw new Error(`size mismatch: ${done}/${expectedBytes}`)
  renameSync(part, dest)
}

/**
 * 安装一个音色包：三个文件下载 → refs.json 落条目 → 自动选中（当前没选别的音色时）
 * → 切权重 + 预热。已在盘上就只做落条目/激活，不重下。
 */
export async function installVoicePack(id: string): Promise<SovitsVoicePack[]> {
  const pack = (await resolveVoicePacks()).find((item) => item.id === id)
  if (!pack) throw new Error(`unknown voicepack: ${id}`)
  const refsRoot = sovitsRefsRoot(app.getPath('userData'))
  const weightsRoot = sovitsWeightsRoot(app.getPath('userData'))
  const run = packRuns.get(pack.id) ?? { downloading: false, progress: 0, error: null }
  if (run.downloading) return sovitsVoicePacks()
  run.downloading = true
  run.error = null
  run.progress = voicePackInstalled(pack, refsRoot, weightsRoot) ? 1 : 0
  packRuns.set(pack.id, run)
  try {
    const plan = planVoicePackFiles(pack, refsRoot, weightsRoot)
    const totalBytes = plan.reduce((sum, file) => sum + file.bytes, 0)
    let doneBytes = 0
    for (const file of plan) {
      const present = existsSync(file.dest) && statSync(file.dest).size === file.bytes
      if (!present) {
        await downloadPackFile(file.url, file.dest, file.bytes, (done) => {
          run.progress = (doneBytes + done) / totalBytes
        })
      }
      doneBytes += file.bytes
      run.progress = doneBytes / totalBytes
    }
    run.progress = 1
    // refs.json 落条目：库文件可能不存在/被手编坏，都当空表起步（listSovitsRefs 同款宽容）。
    const refsFile = join(refsRoot, 'refs.json')
    let current: unknown = []
    if (existsSync(refsFile)) {
      try {
        current = JSON.parse(readFileSync(refsFile, 'utf-8'))
      } catch {
        current = []
      }
    }
    // 换版时同名/同路径的旧条目先剔掉（包拥有自己的名字），旧参考音频记下来给清理步骤。
    const merged = packRefsMerge(current, pack)
    writeFileSync(refsFile, `${JSON.stringify(merged.list, null, 2)}\n`, 'utf-8')
    const stale = cleanupStalePackFiles(pack, merged.staleAudio, refsRoot, weightsRoot)
    if (stale.length > 0) recordSovitsLog('TTS_SOVITS_PACK_CLEANUP', { id: pack.id, files: stale })
    recordSovitsLog('TTS_SOVITS_PACK_READY', { id: pack.id, name: pack.name })
    // 自动选中：当前没配参考（或配的还是空）就选它；用户已经挑了别的音色则不动。
    const settings = loadSettings()
    if (!settings.ttsSovitsRefAudio.trim()) {
      const entry = listSovitsRefs(refsRoot, weightsRoot).find((item) => item.audio === pack.refAudio.relPath)
      if (entry) {
        recordSovitsLog('TTS_SOVITS_PACK_AUTO_SELECT', { id: pack.id })
        await activateSovitsRef(entry)
      }
    }
  } catch (err) {
    run.error = err instanceof Error ? err.message : String(err)
    recordSovitsLog('TTS_SOVITS_PACK_FAIL', { id: pack.id, err: run.error })
  } finally {
    run.downloading = false
  }
  return sovitsVoicePacks()
}

/** 保底参考（幂等）：库里还没有晓晓保底条目时用 Edge 现合成一条；有别的参考（音色包）不拦着。 */
export const SEED_REF_DIR = SOVITS_SEED_REF_DIR
export const SEED_REF_TEXT = '队友们小心，敌人可能在中路埋伏，我们先撤一下再来打。'

export async function ensureSovitsSeedRef(force = false): Promise<boolean> {
  const refsRoot = sovitsRefsRoot(app.getPath('userData'))
  const weightsRoot = sovitsWeightsRoot(app.getPath('userData'))
  if (!force && listSovitsRefs(refsRoot, weightsRoot).some((ref) => ref.audio === `${SEED_REF_DIR}/seed.mp3`))
    return false
  const audioPath = join(refsRoot, SEED_REF_DIR, 'seed.mp3')
  const mp3 = await synthesizeEdge(SEED_REF_TEXT, DEFAULT_EDGE_VOICE, 1)
  if (!mp3 || mp3.length === 0) {
    recordSovitsLog('TTS_SOVITS_SEED_FAIL', { reason: 'edge-empty' })
    return false
  }
  mkdirSync(join(refsRoot, SEED_REF_DIR), { recursive: true })
  writeFileSync(audioPath, mp3)
  const refsFile = join(refsRoot, 'refs.json')
  let current: unknown = []
  if (existsSync(refsFile)) {
    try {
      current = JSON.parse(readFileSync(refsFile, 'utf-8'))
    } catch {
      current = []
    }
  }
  const entry = {
    name: '晓晓（保底）',
    audio: `${SEED_REF_DIR}/seed.mp3`,
    promptText: SEED_REF_TEXT,
    promptLang: 'zh'
  }
  writeFileSync(refsFile, `${JSON.stringify(mergeRefsJson(current, entry), null, 2)}\n`, 'utf-8')
  recordSovitsLog('TTS_SOVITS_SEED_READY', { bytes: mp3.length })
  return true
}

/**
 * 引擎装好后的一键拉齐（装包完成钩子 + 启动钩子共用）：
 * 默认音色包不在就下它；晓晓保底参考缺了就现合成一条（自带幂等，已有则秒返回）——失败也不拦主流程。
 */
export async function autoVoicePackSetup(): Promise<void> {
  const refsRoot = sovitsRefsRoot(app.getPath('userData'))
  const weightsRoot = sovitsWeightsRoot(app.getPath('userData'))
  const fallback = (await resolveVoicePacks()).find((pack) => pack.default)
  if (fallback && !voicePackInstalled(fallback, refsRoot, weightsRoot)) {
    recordSovitsLog('TTS_SOVITS_PACK_AUTO_INSTALL', { id: fallback.id })
    await installVoicePack(fallback.id)
    return
  }
  await ensureSovitsSeedRef()
}
